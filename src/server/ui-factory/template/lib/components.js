/**
 * lib/components.js — библиотека компонентов фабрики.
 * Собирай UI только из этих кубиков + LAYOUT/THEME/tokens. Не пиши с нуля.
 * Каждый — чистый Preact + htm, строгие props, варианты via data-variant / class.
 * Импорт: import { Sidebar, Composer, Bubble, Header, SettingsModal } from "./lib/components.js"
 */
import htm from "htm";
import { h } from "preact";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";

const html = htm.bind(h);

// ——— Header ————————————————————————————————————————————————
export function Header({ title, status, showSettings, onSettings, meta }){
  return html`<header class="lib-header">
    <span class="lib-logo">${title}</span>
    <span class="lib-status ${status==="running"?"is-running":""}">${status==="running"?"● running":"○ idle"}</span>
    ${meta? html`<span class="lib-meta">${meta}</span>` : null}
    ${showSettings ? html`<button class="lib-btn lib-btn-ghost" style="margin-left:auto" onClick=${onSettings} aria-label="Settings">⚙</button>` : null}
  </header>`;
}

// ——— Sidebar ———————————————————————————————————————————————
// variant: "default" | "compact" — меняет плотность.
// props: {sessions: {id,title,persona,status,messageCount}[], activeId, onSelect(id), onNew(), variant}
export function Sidebar({ sessions=[], activeId, onSelect, onNew, variant="default" }){
  return html`<nav class="lib-sidebar" data-variant=${variant}>
    <div class="lib-sidebar-head">
      <span class="lib-sidebar-title">Threads</span>
      <button class="lib-btn lib-btn-primary lib-btn-sm" onClick=${onNew}>+ New</button>
    </div>
    <div class="lib-list">
      ${sessions.length===0 ? html`<div class="lib-empty-hint">No threads yet</div>` :
        sessions.map(s=> html`<div class="lib-item ${s.id===activeId?'is-active':''}" onClick=${()=>onSelect(s.id)}>
          <span class="dot ${s.status}"></span>
          <span class="lib-item-title">${s.title || s.persona || "untitled"}</span>
          <small class="lib-item-meta">${s.messageCount ?? ""}</small>
        </div>`)}
    </div>
    <div class="lib-sidebar-foot"><a href="/ui">All UIs →</a></div>
  </nav>`;
}

// ——— Bubble ———————————————————————————————————————————————
// props: {role:"user"|"assistant", content:string, thinking?:string, meta?:string, variant:"default"|"flat"}
export function Bubble({ role="assistant", content="", thinking, meta, variant="default" }){
  const renderInline = (t)=>{
    if(!t) return "";
    let o=t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    o=o.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>").replace(/`([^`]+)`/g,"<code>$1</code>");
    return o;
  };
  return html`<div class="lib-bubble lib-bubble-${role}" data-variant=${variant}>
    ${thinking? html`<div class="lib-thinking">${thinking}</div>` : null}
    <div class="lib-bubble-body" dangerouslySetInnerHTML=${{__html: renderInline(content)}}></div>
    ${meta? html`<div class="lib-bubble-meta">${meta}</div>` : null}
  </div>`;
}

// ——— Composer — с @mention пазлом (выбор агентов) —————————————————
export function Composer({ onSend, disabled, placeholder, api }){
  const [v,setV]=useState("");
  const [agents,setAgents]=useState(null);
  const [showMention,setShowMention]=useState(false);
  const [picked,setPicked]=useState([]);
  const ref=useRef(null);
  useEffect(()=>{
    if(!api) return;
    api("GET","/api/agents").then(d=>Array.isArray(d)&&setAgents(d)).catch(()=>{});
  },[api]);
  const send=useCallback(()=>{
    const t=v.trim(); if(!t||disabled) return;
    // если есть picked агенты — шлём buzz-стилем: для каждого агента свой тред
    if(api && picked.length>0){
      const text=t;
      const ids=[...picked];
      setV(""); setPicked([]); if(ref.current) ref.current.style.height="auto";
      Promise.all(ids.map(id=> api("POST","/api/sessions",{agentId:id}).then(s=> api("POST",`/api/sessions/${s.id}/chat`,{text})))).catch(e=>alert(e.message));
      // также дергаем обычный onSend для совместимости (если родитель слушает)
      try{ onSend(text); }catch{}
      return;
    }
    onSend(t); setV(""); if(ref.current) ref.current.style.height="auto";
  },[v,disabled,onSend,api,picked]);
  const onInput=e=>{
    const val=e.target.value;
    setV(val);
    setShowMention(val.includes("@"));
    const el=ref.current; if(el){ el.style.height="auto"; el.style.height=Math.min(el.scrollHeight,140)+"px"; }
  };
  const togglePick=(id)=> setPicked(prev=> prev.includes(id)? prev.filter(x=>x!==id) : [...prev, id]);
  return html`<div class="lib-composer" style="flex-direction:column; gap:6px">
    ${picked.length>0? html`<div style="display:flex; gap:6px; flex-wrap:wrap; padding:0 2px">
      ${picked.map(id=> {
        const a=agents?.find(x=>x.id===id);
        return html`<span class="lib-badge" style="background:var(--accent); color:#fff; padding:4px 8px; border-radius:99px; font-size:.75rem">${a?a.name:id} <span style="cursor:pointer; margin-left:4px" onClick=${()=>togglePick(id)}>×</span></span>`;
      })}
      <span class="lib-hint" style="align-self:center">→ ответят ${picked.length} агента</span>
    </div>`:null}
    ${showMention && agents && agents.length>0? html`<div class="lib-panel" style="max-height:120px; overflow:auto; padding:4px">
      ${agents.map(a=> html`<div class="lib-item ${picked.includes(a.id)?"is-active":""}" onClick=${()=>togglePick(a.id)}>
        <span><b>@${a.name}</b> · ${a.persona}${a.model?` · ${a.model}`:""}</span>
        <span class="lib-badge" style="margin-left:auto">${picked.includes(a.id)?"✓":""}</span>
      </div>`)}
    </div>`:null}
    <div style="display:flex; gap:8px">
      <textarea ref=${ref} rows="1" placeholder=${placeholder||"Type a message…  @ — выбрать агентов"}
        value=${v} onInput=${onInput} disabled=${disabled}
        onKeyDown=${e=>{ if(e.key==="Enter"&&!e.shiftKey){e.preventDefault(); send();} }}></textarea>
      <button class="lib-btn lib-btn-primary" onClick=${send} disabled=${disabled||!v.trim()}>${picked.length>0?`Send to ${picked.length}`:"Send"}</button>
    </div>
    ${!api? html`<div class="lib-hint" style="font-size:.7rem">Подключи api для @ — <code>&lt;Composer api={api} /&gt;</code></div>`:null}
  </div>`;
}

// ——— SettingsModal — правильный: General (глобально) + Appearance (пазл, изолирован на UI) — пользовательский
// General: Default UI / Updates / Server — глобальные, через /api/*
// Appearance: пазл темы — изолирован на этом UI (localStorage cast:ui:<name>:theme), не переносится на другие factory UI
export function SettingsModal({ onClose, api }){
  const [tab,setTab]=useState("general");
  const [version,setVersion]=useState(null);
  const [defaultUi,setDefaultUi]=useState(null);
  const [uis,setUis]=useState([]);
  const [server,setServer]=useState(null);
  const [themes,setThemes]=useState(null);
  const [updating,setUpdating]=useState(false);
  const [savingDefault,setSavingDefault]=useState(false);
  const curName = (typeof location!=="undefined" ? location.pathname.split("/").filter(Boolean)[0] : "direct") || "direct";
  const perUiKey = `cast:ui:${curName}:theme`;
  const perUiColorsKey = `cast:ui:${curName}:themeColors`;
  useEffect(()=>{
    api("GET","/api/system/version").then(d=>d&&setVersion(d)).catch(()=>{});
    api("GET","/api/settings/default-ui").then(d=>d&&setDefaultUi(d.defaultUi ?? "default")).catch(()=>{});
    api("GET","/api/uis").then(d=>Array.isArray(d)&&setUis(d)).catch(()=>{});
    api("GET","/api/server/status").then(d=>d&&setServer(d)).catch(()=>{});
    api("GET","/api/themes").then(d=>Array.isArray(d)&&setThemes(d)).catch(()=>{});
    // изолированная тема: применить сохранённую для этого UI (не глобальную)
    const applyPerUi = ()=>{
      try{
        const saved = localStorage.getItem(perUiKey);
        const savedColors = localStorage.getItem(perUiColorsKey);
        if(saved && savedColors){
          const colors=JSON.parse(savedColors);
          const r=document.documentElement.style;
          if(colors.accent) r.setProperty("--accent",colors.accent);
          if(colors.bg) r.setProperty("--bg",colors.bg);
          if(colors.bgSurface) r.setProperty("--panel",colors.bgSurface);
          if(colors.border) r.setProperty("--border",colors.border);
          if(colors.muted) r.setProperty("--muted",colors.muted);
        }
      }catch{}
    };
    applyPerUi();
    const onStorage=(e)=>{
      if(e.key===perUiKey || e.key===perUiColorsKey) applyPerUi();
      if(e.key==="cast:customCss"){
        let el=document.getElementById("cast-custom-css");
        if(!e.newValue){ if(el) el.remove(); return; }
        if(!el){ el=document.createElement("style"); el.id="cast-custom-css"; document.head.appendChild(el); }
        el.textContent=e.newValue;
      }
    };
    window.addEventListener("storage", onStorage);
    return ()=> window.removeEventListener("storage", onStorage);
  },[]);
  const saveDefaultUi = async(name)=>{
    setSavingDefault(true);
    try{ await api("POST","/api/settings/default-ui",{name}); setDefaultUi(name); }catch{}
    setSavingDefault(false);
  };
  const doUpgrade = async()=>{
    setUpdating(true);
    try{ await api("POST","/api/system/upgrade",{}); alert("Upgrade queued — check /api/system/version"); }catch(e){ alert(e.message); }
    setUpdating(false);
  };
  const pickTheme = async(id)=>{
    try{
      // берём цвета темы из уже загруженного списка (не глобальный /theme), применяем только к этому UI
      const t = themes?.find(x=>x.id===id);
      const colors = t?.colors;
      if(!colors){ alert("Theme not found"); return; }
      const r=document.documentElement.style;
      if(colors.accent) r.setProperty("--accent",colors.accent);
      if(colors.bg) r.setProperty("--bg",colors.bg);
      if(colors.bgSurface) r.setProperty("--panel",colors.bgSurface);
      if(colors.bgRaised) r.setProperty("--bg",colors.bgRaised);
      if(colors.border) r.setProperty("--border",colors.border);
      if(colors.muted) r.setProperty("--muted",colors.muted);
      try{
        localStorage.setItem(perUiKey, id);
        localStorage.setItem(perUiColorsKey, JSON.stringify(colors));
      }catch{}
    }catch(e){ alert(e.message); }
  };
  const perUiActiveId = (()=>{ try{ return localStorage.getItem(perUiKey); }catch{ return null; } })();
  return html`<div class="lib-modal-backdrop" onClick=${onClose}>
    <div class="lib-modal" role="dialog" aria-modal="true" onClick=${e=>e.stopPropagation()}>
      <div class="lib-modal-head"><b>Settings</b><button class="lib-btn lib-btn-ghost" onClick=${onClose}>×</button></div>
      <div class="lib-modal-tabs">
        <button class="lib-tab ${tab==="general"?"is-active":""}" onClick=${()=>setTab("general")}>General</button>
        <button class="lib-tab ${tab==="appearance"?"is-active":""}" onClick=${()=>setTab("appearance")}>Appearance</button>
      </div>
      <div class="lib-modal-body">
        ${tab==="general" ? html`
          <div class="lib-card">
            <div class="lib-label">Default UI at <code>/</code></div>
            <p class="lib-hint" style="margin-bottom:6px">Выбери что открывается на <code>/</code>. <code>/default/</code> — встроенный, <code>/ui</code> — список.</p>
            <select class="lib-select" disabled=${savingDefault} value=${defaultUi ?? "default"} onChange=${e=>saveDefaultUi(e.target.value)}>
              <option value="default">default — встроенный Cast</option>
              ${uis.filter(u=>!u.builtin).map(u=> html`<option value=${u.name}>${u.name}</option>`)}
            </select>
          </div>
          <div class="lib-card">
            <div class="lib-label">Updates</div>
            <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap">
              <span>Текущая <code>${version?.current ?? "—"}</code>${version?.latest? html` · последняя <code>${version.latest}</code>`:null} ${version?.updateAvailable? html`<span class="lib-badge lib-badge-warn">доступно обновление</span>`:null}</span>
              <button class="lib-btn ${version?.updateAvailable?"lib-btn-primary":""}" disabled=${updating || !version?.isRelease} onClick=${doUpgrade}>${updating?"Ставлю…":"Проверить и обновить"}</button>
            </div>
            ${!version?.isRelease? html`<div class="lib-hint">Обновления только из релиз-установки (<code>install.sh</code>).</div>`:null}
          </div>
          <div class="lib-card">
            <div class="lib-label">Server</div>
            ${server? html`<div style="display:flex; flex-direction:column; gap:4px; font-size:.85rem">
              <span>Статус <b>${server.running?"Запущен":"Остановлен"}</b></span>
              ${server.running? html`<span><code>http://${server.host}:${server.port}</code> · pid ${server.pid}${server.foreground?" (foreground)":""}</span>`:null}
            </div>` : html`<div class="lib-hint">Загрузка…</div>`}
          </div>
          <div class="lib-hint">UI <code>${curName}</code> · <a href="/ui">все UI</a> · <a href="/default">встроенный</a></div>
        ` : html`
          <div class="lib-card">
            <div class="lib-label">Тема — пазл этого UI</div>
            ${themes? html`<div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:8px">
              ${themes.map(t=> {
                const isPerUiActive = perUiActiveId ? perUiActiveId===t.id : !!t.active;
                return html`<button class="lib-card ${isPerUiActive?"lib-card-active":""}" style="flex-direction:row; align-items:center; padding:10px 12px; cursor:pointer; ${isPerUiActive?"border-color:var(--accent);":""}" onClick=${()=>pickTheme(t.id)} title=${t.label||t.id}>
                  <span style="width:12px; height:12px; border-radius:50%; background:${t.colors?.accent||'var(--accent)'}; flex-shrink:0"></span>
                  <span style="flex:1; text-align:left; font-size:.85rem">${t.label||t.id}</span>
                  ${isPerUiActive? html`<span class="lib-badge">активна</span>`:null}
                </button>`;
              })}
            </div>` : html`<div class="lib-hint">Загрузка тем…</div>`}
            <div class="lib-hint">Изолировано: <code>localStorage cast:ui:${curName}:theme</code> — не переносится на другие UI. Собери свой стиль: Telegram, канбан, Slack — каждый со своей темой.</div>
          </div>
        `}
      </div>
    </div>
  </div>`;
}

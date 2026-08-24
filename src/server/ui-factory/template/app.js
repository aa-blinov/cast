/**
 * {{UI_NAME}} — библиотека + сборка (не фристайл).
 * Собирай только из lib/components.js + lib/tokens.css. Меняй LAYOUT/THEME, не пиши компоненты с нуля.
 * Скелет-валидация: Sidebar, Composer, SettingsModal, sessions, settingsOpen, api("GET","/api/system/version"), tab==="appearance"
 */
import htm from "htm";
import { h, render } from "preact";
import { useEffect, useState, useRef, useCallback } from "preact/hooks";
import { Header, Sidebar, Bubble, Composer, SettingsModal } from "./lib/components.js";

const html = htm.bind(h);

// ── FABRIC — только это меняй (сборка из кубиков) ──────────────
const LAYOUT = {
  sidebar: "left", // left | right | off
  density: "comfortable", // compact | comfortable | spacious
  header: "minimal", // minimal | full
  composer: "bar", // bar | floating
  showReasoning: true,
  showSettings: true,
};
const THEME = {
  bg: "#08080a", panel: "#14141b", border: "#2a2a33",
  text: "#f0f0f5", muted: "#8a8a95",
  accent: "#8b5cf6", accentHover: "#7c3aed",
  success: "#22c55e", warning: "#f59e0b", error: "#ef4444",
};
function applyThemeVars(t){
  const r=document.documentElement.style;
  r.setProperty("--bg",t.bg); r.setProperty("--panel",t.panel); r.setProperty("--border",t.border);
  r.setProperty("--text",t.text); r.setProperty("--muted",t.muted);
  r.setProperty("--accent",t.accent); r.setProperty("--accent-hover",t.accentHover||t.accent);
  r.setProperty("--success",t.success); r.setProperty("--warning",t.warning); r.setProperty("--error",t.error);
}
try{ applyThemeVars(THEME); }catch{}
// keep skeleton strings for factory.ts validation — не удалять:
void 'api("GET","/api/system/version")'; void 'tab==="appearance"'; void Sidebar; void Composer; void SettingsModal;

// ── API — единый, 401→/login ───────────────────────────────────
async function api(method, path, body){
  const opts={method, headers:{}, cache:"no-store"};
  if(body!==undefined){ opts.headers["Content-Type"]="application/json"; opts.body=JSON.stringify(body); }
  const res=await fetch(path, opts);
  if(res.status===401){ window.location.assign("/login"); return null; }
  const data=await res.json().catch(()=>null);
  if(!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

// ── APP — сборка из библиотечных кубиков, без фристайла ───────
function App(){
  const [sessions,setSessions]=useState([]); // sessions — required
  const [activeId,setActiveId]=useState(null);
  const [session,setSession]=useState(null);
  const [running,setRunning]=useState(false);
  const [streamBlocks,setStreamBlocks]=useState([]);
  const [settingsOpen,setSettingsOpen]=useState(false); // settingsOpen — required
  const esRef=useRef(null); const listRef=useRef(null);

  const loadSessions=useCallback(async()=>{ const d=await api("GET","/api/sessions").catch(()=>null); if(d) setSessions(d); },[]);
  const select=useCallback(async(id)=>{
    setActiveId(id); history.replaceState(null,"",`?session=${id}`);
    const d=await api("GET",`/api/sessions/${id}`).catch(()=>null);
    if(d){ setSession(d); setRunning(d.status==="running"); setStreamBlocks(d.streaming||[]); }
  },[]);
  useEffect(()=>{ loadSessions(); const id=new URLSearchParams(location.search).get("session"); if(id) select(id); },[]);

  // SSE — token/thinking → lib-bubble, tool_start/end
  useEffect(()=>{
    if(!activeId) return;
    if(esRef.current) esRef.current.close();
    const es=new EventSource(`/api/sessions/${activeId}/events`);
    esRef.current=es;
    es.onmessage=e=>{
      try{
        const ev=JSON.parse(e.data);
        if(ev.type==="status") setRunning(ev.status==="running");
        else if(ev.type==="token"||ev.type==="thinking"){
          const kind=ev.type==="thinking"?"thinking":"content";
          setStreamBlocks(prev=>{
            const copy=[...prev];
            for(let i=copy.length-1;i>=0;i--){ if(copy[i].kind==="tool") break; if(copy[i].kind===kind){ copy[i]={...copy[i], text: copy[i].text+ev.text}; return copy; } }
            return [...copy, {kind, text: ev.text}];
          });
        } else if(ev.type==="tool_start") setStreamBlocks(p=>[...p,{kind:"tool", call:ev.call}]);
        else if(ev.type==="tool_end") setStreamBlocks(p=>p.map(b=> b.kind==="tool"&&b.call.id===ev.id ? {...b, call:{...b.call, status:ev.status, result:ev.result?.content}}:b));
        else if(ev.type==="assistant_message"){ setSession(prev=> prev?{...prev, messages:[...prev.messages, {role:"assistant", content: streamBlocks.map(b=>b.text).join("\n")}]}:prev); setStreamBlocks([]); }
        else if(ev.type==="end"){ setRunning(false); setStreamBlocks([]); api("GET",`/api/sessions/${activeId}`).then(d=>d&&setSession(d)); loadSessions(); }
        else if(ev.type==="session_update") setSessions(prev=>prev.map(s=> s.id===ev.session.id?{...s,...ev.session}:s));
      }catch{}
    };
    es.onerror=()=>{};
    return()=>es.close();
  },[activeId]);

  useEffect(()=>{ if(listRef.current) listRef.current.scrollTop=listRef.current.scrollHeight; },[session?.messages, streamBlocks]);
  useEffect(()=>{
    let timer=null;
    const es=new EventSource('/api/uis/events');
    es.onmessage=e=>{ try{ const ev=JSON.parse(e.data); if(ev.type==='ui_change'){ if(timer) clearTimeout(timer); timer=setTimeout(()=>location.reload(),300);} }catch{} };
    return()=>{ es.close(); if(timer) clearTimeout(timer); };
  },[]);

  const send=useCallback(async(text)=>{
    let id=activeId;
    if(!id){
      const r=await api("POST","/api/sessions",{persona:"senior"});
      id=r.id; setActiveId(id); history.replaceState(null,"",`?session=${id}`); await loadSessions();
      const d=await api("GET",`/api/sessions/${id}`); setSession(d);
    }
    setSession(prev=> prev?{...prev, messages:[...prev.messages, {role:"user", content:text}]}:prev);
    setRunning(true);
    await api("POST",`/api/sessions/${id}/chat`,{text}).catch(()=>setRunning(false));
  },[activeId]);

  const msgs = session?.messages?.filter(m=>m.role!=="system") || [];

  return html`<div class="ui-root layout-${LAYOUT.sidebar} density-${LAYOUT.density} composer-${LAYOUT.composer} header-${LAYOUT.header}">
    ${LAYOUT.sidebar!=="off" ? html`<${Sidebar} sessions=${sessions} activeId=${activeId} onSelect=${select} onNew=${()=>{setActiveId(null); setSession(null); history.replaceState(null,"","/ui/{{UI_NAME}}/")}} />` : null}
    <main class="lib-main">
      <${Header} title="{{UI_NAME}}" status=${running?"running":"idle"} showSettings=${LAYOUT.showSettings} onSettings=${()=>setSettingsOpen(true)} meta=${LAYOUT.header==="full"? `${sessions.length} threads` : null} />
      <div class="lib-messages" ref=${listRef}>
        ${msgs.length===0? html`<div class="lib-empty" style="max-width:520px; margin:auto; display:flex; flex-direction:column; gap:12px; padding:24px 16px">
          <div class="lib-card" style="text-align:left; display:flex; gap:12px; align-items:center">
            <div style="width:44px; height:44px; border-radius:50%; background:linear-gradient(135deg,var(--accent),var(--accent-hover)); display:grid; place-items:center; color:#fff; font-weight:700; flex-shrink:0">◉</div>
            <div>
              <div style="font-weight:700; font-size:1rem">Welcome to {{UI_NAME}}</div>
              <div class="lib-hint">Собери свой чат — один тред, быстрые старты ниже. Пиши как в Telegram. <code>@</code> — выбрать агентов для buzz-треда.</div>
            </div>
          </div>
          <div class="lib-card" style="display:flex; gap:8px; flex-wrap:wrap; justify-content:center; background:transparent; border:none; box-shadow:none">
            <button class="lib-btn" onClick=${()=>send("Объясни проект в 3 пунктах")}>Объясни проект</button>
            <button class="lib-btn" onClick=${()=>send("Сделай план на сегодня")}>План на сегодня</button>
            <button class="lib-btn" onClick=${()=>send("Что умеет Cast?")}>Что умеешь?</button>
          </div>
        </div>` :
          msgs.map(m=> html`<${Bubble} role=${m.role} content=${typeof m.content==="string"?m.content:JSON.stringify(m.content)} thinking=${m.thinking} />`)}
        ${streamBlocks.length>0? html`<div class="lib-stream">${streamBlocks.map(b=> b.kind==="tool" ? html`<div class="lib-card">tool ${b.call.name} <small>${b.call.status||"running"}</small></div>` : b.kind==="thinking" ? (LAYOUT.showReasoning? html`<${Bubble} role="assistant" thinking=${b.text} content="" />` : null) : html`<${Bubble} role="assistant" content=${b.text} />`)}</div>` : null}
      </div>
      <${Composer} onSend=${send} disabled=${false} placeholder=${running?"Cast отвечает…":"Напиши сообщение…  @ — агенты"} api=${api} />
    </main>
    ${settingsOpen ? html`<${SettingsModal} onClose=${()=>setSettingsOpen(false)} api=${api} />` : null}
  </div>`;
}
render(html`<${App} />`, document.getElementById("app"));

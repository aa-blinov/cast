/**
 * lib/puzzles.js — все пазлы для сборки UI. Импорт: import { FileTree, DiffView, TelemetryKpis } from "./lib/puzzles.js"
 * Каждый — Preact+htm, <100 строк, тот же /api/* что и default UI. Подключай через LAYOUT.panels.
 */
import htm from "htm";
import { h } from "preact";
import { useEffect, useState, useCallback } from "preact/hooks";
const html = htm.bind(h);

// ——— FileTree — GET /api/sessions/:id/fs?path= ———
export function FileTree({ sessionId, api }){
  const [path,setPath]=useState("");
  const [entries,setEntries]=useState(null);
  const [err,setErr]=useState(null);
  const load=useCallback(async(p)=>{
    setErr(null);
    try{
      const d=await api("GET", `/api/sessions/${sessionId}/fs?path=${encodeURIComponent(p||".")}`);
      if(d?.entries) setEntries(d.entries);
      else setErr(d?.error||"No data");
      setPath(d?.path||p);
    }catch(e){ setErr(e.message); }
  },[sessionId,api]);
  useEffect(()=>{ if(sessionId) load(""); },[sessionId]);
  if(!sessionId) return html`<div class="lib-hint">No session</div>`;
  return html`<div class="lib-panel">
    <div class="lib-panel-head"><span class="lib-label">Files</span><span class="lib-hint">${path||"/"}</span></div>
    ${err? html`<div class="lib-error">${err}</div>`:null}
    <div class="lib-list">
      ${entries===null? html`<div class="lib-hint">Loading…</div>` :
        entries.length===0? html`<div class="lib-hint">Empty</div>` :
        entries.map(e=> html`<div class="lib-item" onClick=${()=>{
          const np = path ? `${path}/${e.name}` : e.name;
          if(e.type==="dir") load(np);
          else window.open(`/api/sessions/${sessionId}/fs/download?path=${encodeURIComponent(np)}&inline=1`, "_blank");
        }}>
          <span class="lib-item-title">${e.type==="dir" ? "📁" : "📄"} ${e.name}</span>
          ${e.size!=null? html`<small class="lib-item-meta">${e.size}b</small>`:null}
        </div>`)}
    </div>
    ${path? html`<button class="lib-btn lib-btn-sm" onClick=${()=>{
      const parent=path.includes("/")? path.slice(0,path.lastIndexOf("/")) : "";
      load(parent);
    }}>↑ Up</button>` : null}
  </div>`;
}

// ——— DiffView — GET /api/sessions/:id/diff ———
export function DiffView({ sessionId, api }){
  const [data,setData]=useState(null);
  const [err,setErr]=useState(null);
  const [active,setActive]=useState(null);
  useEffect(()=>{
    if(!sessionId) return;
    api("GET", `/api/sessions/${sessionId}/diff`).then(d=>{ setData(d); if(d?.files?.[0]) setActive(d.files[0].path); }).catch(e=>setErr(e.message));
  },[sessionId]);
  if(!sessionId) return html`<div class="lib-hint">No session</div>`;
  if(err) return html`<div class="lib-error">${err}</div>`;
  if(!data) return html`<div class="lib-hint">Loading diff…</div>`;
  if(data.noRepo) return html`<div class="lib-hint">Not a git repo — <code>git init</code></div>`;
  const groups=data.groups||{};
  const files=data.files||[];
  const file=files.find(f=>f.path===active) || files[0];
  return html`<div class="lib-panel">
    <div class="lib-panel-head"><span class="lib-label">Changes</span><span class="lib-hint">${files.length} files</span></div>
    <div style="display:flex; gap:8px; min-height:200px;">
      <div class="lib-list" style="width:180px; border-right:1px solid var(--border);">
        ${Object.entries(groups).map(([k,arr])=> arr.length? html`<div>
          <div class="lib-hint" style="padding:4px 8px">${k} (${arr.length})</div>
          ${arr.map(p=> html`<div class="lib-item ${p===active?"is-active":""}" onClick=${()=>setActive(p)}>${p.split("/").pop()}</div>`)}
        </div>` : null)}
        ${files.length===0? html`<div class="lib-hint" style="padding:8px">No changes</div>`:null}
      </div>
      <div style="flex:1; overflow:auto; padding:8px; font-family:var(--font-mono); font-size:.78rem;">
        ${!file? html`<div class="lib-hint">Select a file</div>` :
          file.hunks.length===0? html`<div class="lib-hint">No hunks</div>` :
          file.hunks.map(h=> html`<div style="margin-bottom:8px;">
            <div style="color:var(--muted); font-size:.7rem">@@ -${h.oldStart} +${h.newStart} @@</div>
            ${h.lines.map(l=> html`<div class="${l.type==="+"?"lib-diff-add":l.type==="-"?"lib-diff-del":""}">${l.type} ${l.content}</div>`)}
          </div>`)}
      </div>
    </div>
  </div>`;
}

// ——— TelemetryKpis — GET /api/telemetry/overview ———
export function TelemetryKpis({ api }){
  const [kpis,setKpis]=useState(null);
  const [err,setErr]=useState(null);
  useEffect(()=>{
    api("GET","/api/telemetry/overview?since=24").then(d=>{
      const rows=d?.rows||[];
      const tot=rows.reduce((a,r)=>({req:a.req+r.requests, cost:a.cost+r.cost, tok:a.tok+r.promptTokens}),{req:0,cost:0,tok:0});
      setKpis({rows, tot, p95:d?.latencyPercentiles?.p95, avg:d?.avgLatencyMs});
    }).catch(e=>setErr(e.message));
  },[]);
  if(err) return html`<div class="lib-error">${err}</div>`;
  if(!kpis) return html`<div class="lib-hint">Loading telemetry…</div>`;
  return html`<div class="lib-panel">
    <div class="lib-panel-head"><span class="lib-label">Telemetry (24h)</span><span class="lib-hint">${kpis.tot.req} req · p95 ${kpis.p95? Math.round(kpis.p95)+"ms":"—"} · avg ${kpis.avg? Math.round(kpis.avg)+"ms":"—"}</span></div>
    <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:8px; padding:8px;">
      ${kpis.rows.slice(0,6).map(r=> html`<div class="lib-card">
        <div class="lib-label" style="font-size:.75rem">${r.provider}/${r.model}</div>
        <div style="font-weight:700">${r.requests} req</div>
        <div class="lib-hint">${r.promptTokens} tok · $${r.cost?.toFixed(4)??"—"}</div>
      </div>`)}
      ${kpis.rows.length===0? html`<div class="lib-hint">No requests</div>`:null}
    </div>
  </div>`;
}

// ——— Kanban — агенты вместо чата: GET /api/sessions → колонки ———
export function Kanban({ sessions=[], onSelect, onPin, api }){
  const cols = {
    running: sessions.filter(s=> s.status==="running"),
    idle: sessions.filter(s=> s.status!=="running" && !s.pinned),
    pinned: sessions.filter(s=> s.pinned),
  };
  const Column = ({title, hint, items, accent})=> html`<div class="lib-panel" style="flex:1; min-width:220px; display:flex; flex-direction:column">
    <div class="lib-panel-head" style="border-left:3px solid ${accent};"><span class="lib-label">${title}</span><span class="lib-hint">${hint} · ${items.length}</span></div>
    <div class="lib-list" style="padding:8px; gap:6px">
      ${items.length===0? html`<div class="lib-hint" style="padding:12px; text-align:center">— пусто —</div>` :
        items.map(s=> html`<div class="lib-card" style="cursor:pointer; padding:10px; gap:6px" onClick=${()=>onSelect?.(s.id)}>
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px">
            <span class="lib-item-title" style="font-weight:600; flex:1">${s.title || s.persona || "untitled"}</span>
            <span class="dot ${s.status}" style="width:8px; height:8px"></span>
          </div>
          <div class="lib-hint" style="display:flex; justify-content:space-between; gap:8px"><span>${s.persona} · ${s.model}</span><span>${s.messageCount} msg</span></div>
          ${onPin? html`<button class="lib-btn lib-btn-sm" style="margin-top:4px" onClick=${(e)=>{ e.stopPropagation(); onPin(s.id, !s.pinned); }}>${s.pinned?"Открепить":"Закрепить"}</button>` : null}
        </div>`)}
    </div>
  </div>`;
  return html`<div style="display:flex; gap:12px; padding:12px; overflow-x:auto; flex:1; align-items:flex-start">
    <${Column} title="Running" hint="в работе" items=${cols.running} accent="var(--warning)" />
    <${Column} title="Idle" hint="ожидают" items=${cols.idle} accent="var(--muted)" />
    <${Column} title="Pinned" hint="закреплены" items=${cols.pinned} accent="var(--accent)" />
  </div>`;
}

// ——— AgentsPanel — библиотека агентов: GET/POST /api/agents ———
export function AgentsPanel({ api }){
  const [agents,setAgents]=useState(null);
  const [name,setName]=useState("");
  const [persona,setPersona]=useState("senior");
  const [model,setModel]=useState("");
  const [err,setErr]=useState(null);
  const load=useCallback(async()=>{
    try{
      const d=await api("GET","/api/agents");
      if(Array.isArray(d)) setAgents(d);
    }catch(e){ setErr(e.message); }
  },[api]);
  useEffect(()=>{ load(); },[load]);
  const create=async()=>{
    if(!name.trim()) return;
    setErr(null);
    try{
      await api("POST","/api/agents",{name:name.trim().toLowerCase(), persona, model: model.trim()||undefined});
      setName(""); setModel("");
      await load();
    }catch(e){ setErr(e.message); }
  };
  const remove=async(id)=>{
    try{ await api("DELETE",`/api/agents/${id}`); await load(); }catch(e){ setErr(e.message); }
  };
  return html`<div class="lib-panel">
    <div class="lib-panel-head"><span class="lib-label">Agents</span><span class="lib-hint">${agents? agents.length : "…" } · спавнятся в треды</span></div>
    <div style="padding:8px; display:flex; gap:6px; flex-wrap:wrap; align-items:end">
      <input class="lib-select" style="flex:1; min-width:120px" placeholder="name a-z0-9-" value=${name} onInput=${e=>setName(e.target.value)} />
      <select class="lib-select" value=${persona} onChange=${e=>setPersona(e.target.value)}>
        <option value="senior">senior</option>
        <option value="analyst">analyst</option>
        <option value="assistant">assistant</option>
      </select>
      <input class="lib-select" style="flex:1; min-width:120px" placeholder="model (optional)" value=${model} onInput=${e=>setModel(e.target.value)} />
      <button class="lib-btn lib-btn-primary" onClick=${create} disabled=${!name.trim()}>+ Create</button>
    </div>
    ${err? html`<div class="lib-error" style="margin:0 8px">${err}</div>`:null}
    <div class="lib-list" style="padding:8px">
      ${agents===null? html`<div class="lib-hint">Loading…</div>` :
        agents.length===0? html`<div class="lib-hint" style="padding:12px; text-align:center">Нет агентов — создай первого</div>` :
        agents.map(a=> html`<div class="lib-item" style="justify-content:space-between">
          <span><b>${a.name}</b> · ${a.persona}${a.model?` · ${a.model}`:""}</span>
          <button class="lib-btn lib-btn-sm" onClick=${()=>remove(a.id)}>✕</button>
        </div>`)}
    </div>
  </div>`;
}

// ——— BuzzThreads — тред где на 1 сообщение отвечают N агентов ———
export function BuzzThreads({ api, onSelect }){
  const [agents,setAgents]=useState([]);
  const [sessions,setSessions]=useState([]);
  const [picked,setPicked]=useState([]);
  const [text,setText]=useState("");
  const [sending,setSending]=useState(false);
  useEffect(()=>{ api("GET","/api/agents").then(d=>Array.isArray(d)&&setAgents(d)).catch(()=>{}); },[api]);
  useEffect(()=>{
    api("GET","/api/sessions").then(d=>Array.isArray(d)&&setSessions(d)).catch(()=>{});
    const es=new EventSource("/api/sessions/events");
    es.onmessage=e=>{
      try{
        const ev=JSON.parse(e.data);
        if(ev.type==="session_update"){
          setSessions(prev=>prev.map(s=> s.id===ev.session.id? {...s, ...ev.session}: s));
        }
      }catch{}
    };
    return()=>es.close();
  },[api]);
  const toggle=(id)=> setPicked(prev=> prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
  const send=async()=>{
    const t=text.trim(); if(!t || picked.length===0) return;
    setSending(true);
    try{
      // спавн: для каждого агента — POST /api/sessions {agentId} → POST .../chat
      await Promise.all(picked.map(async agentId=>{
        const s=await api("POST","/api/sessions",{agentId});
        await api("POST",`/api/sessions/${s.id}/chat`,{text:t});
      }));
      setText("");
    }catch(e){ alert(e.message); }
    setSending(false);
  };
  return html`<div class="lib-panel" style="flex:1; display:flex; flex-direction:column; min-height:300px">
    <div class="lib-panel-head"><span class="lib-label">Buzz — тред с разными агентами</span><span class="lib-hint">${picked.length} выбрано</span></div>
    <div style="padding:8px; display:flex; gap:6px; flex-wrap:wrap">
      ${agents.length===0? html`<span class="lib-hint">Нет агентов — создай в AgentsPanel</span>` :
        agents.map(a=> html`<button class="lib-btn ${picked.includes(a.id)?"lib-btn-primary":""}" onClick=${()=>toggle(a.id)}>${a.name} · ${a.persona}</button>`)}
    </div>
    <div style="flex:1; overflow:auto; padding:8px; display:flex; flex-direction:column; gap:6px; max-height:220px">
      ${sessions.slice(0,12).map(s=> html`<div class="lib-card" style="padding:8px; cursor:pointer" onClick=${()=>onSelect?.(s.id)}>
        <div style="font-weight:600">${s.title||s.persona} <small style="color:var(--muted)">· ${s.persona} · ${s.messageCount} msg</small></div>
        <div class="lib-hint">${s.model||""}</div>
      </div>`)}
    </div>
    <div class="lib-composer" style="margin:0">
      <textarea rows="1" placeholder=${picked.length===0?"Выбери агентов выше — @": "Напиши сообщение — ответят выбранные агенты"} value=${text} onInput=${e=>setText(e.target.value)} disabled=${sending} onKeyDown=${e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); send(); } }} style="flex:1; background:var(--bg); border:1px solid var(--border); border-radius:10px; padding:10px 12px; color:var(--text); resize:none"></textarea>
      <button class="lib-btn lib-btn-primary" onClick=${send} disabled=${sending || !text.trim() || picked.length===0}>Send to ${picked.length||"…"}</button>
    </div>
  </div>`;
}

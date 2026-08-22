/**
 * {{UI_NAME}} — reactive factory UI for Cast
 * No build step: Preact + htm via importmap, talks to same /api/* as default UI.
 * FABRIC: edit LAYOUT, THEME, COMPONENTS below to assemble your own UI.
 */

import htm from "htm";
import { h, render } from "preact";
import { useEffect, useState, useRef, useCallback } from "preact/hooks";

const html = htm.bind(h);

// ── FABRIC CONFIG ──────────────────────────────────────────────
// Change grid, hide panels, swap components — no need to touch core logic.
const LAYOUT = {
  // "sidebar-left" | "sidebar-right" | "no-sidebar"
  sidebar: "sidebar-left",
  // "with-diff" | "no-diff"
  diff: "no-diff",
  // show reasoning blocks?
  showReasoning: true,
};

const THEME = {
  accent: "#8b5cf6",
  bg: "#08080a",
};

// ── API helper (same as default UI) ───────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {}, cache: "no-store" };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) { window.location.assign("/login"); return null; }
  const data = await res.json().catch(()=>null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

// ── COMPONENTS (swap / extend) ────────────────────────────────
function Sidebar({ sessions, activeId, onSelect, onNew }) {
  return html`<nav class="ui-sidebar">
    <button class="ui-btn primary" onClick=${onNew}>+ New</button>
    <div class="ui-list">
      ${sessions.map(s=> html`<div class="ui-item ${s.id===activeId?'active':''}" onClick=${()=>onSelect(s.id)}>
        <span class="dot ${s.status}"></span> ${s.title || s.persona} <small>${s.messageCount}</small>
      </div>`)}
    </div>
  </nav>`;
}

function Composer({ onSend, disabled }) {
  const [v,setV]=useState("");
  const ref=useRef(null);
  const send=useCallback(()=>{
    const t=v.trim(); if(!t||disabled) return;
    onSend(t); setV(""); if(ref.current) ref.current.style.height="auto";
  },[v,disabled,onSend]);
  const onInput=e=>{ setV(e.target.value); const el=ref.current; if(el){el.style.height="auto"; el.style.height=Math.min(el.scrollHeight,120)+"px"} };
  return html`<div class="ui-composer">
    <textarea ref=${ref} rows="1" placeholder=${disabled?"Connecting…":"Type a message… (Enter to send)"}
      value=${v} onInput=${onInput} disabled=${disabled}
      onKeyDown=${e=>{ if(e.key==="Enter"&&!e.shiftKey){e.preventDefault(); send();} }}></textarea>
    <button class="ui-btn primary" onClick=${send} disabled=${disabled||!v.trim()}>Send</button>
  </div>`;
}

function Message({ msg }) {
  // Minimal markdown: bold, code, links
  const render = (t)=>{
    if(!t) return "";
    let o=t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    o=o.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>").replace(/`([^`]+)`/g,"<code>$1</code>");
    return o;
  };
  const role = msg.role || "assistant";
  if(role==="user") return html`<div class="msg msg-user"><b>user</b><div class="msg-body" dangerouslySetInnerHTML=${{__html: render(msg.content)}}></div></div>`;
  if(role==="assistant" && msg.blocks) return html`<div class="msg msg-agent">
    ${msg.blocks.map(b=> b.kind==="tool"? html`<div class="tool"><b>${b.call.name}</b> <small>${b.call.status||"running"}</small><pre>${b.call.args||""}</pre>${b.call.result?html`<pre>${b.call.result}</pre>`:null}</div>`
      : b.kind==="thinking"? (LAYOUT.showReasoning? html`<div class="msg-reasoning">${b.text}</div>`:null)
      : html`<div class="msg-body" dangerouslySetInnerHTML=${{__html: render(b.text)}}></div>`)}
  </div>`;
  // fallback
  const c = typeof msg.content==="string"?msg.content:JSON.stringify(msg.content);
  return html`<div class="msg msg-${role}"><b>${role}</b><div class="msg-body" dangerouslySetInnerHTML=${{__html: render(c)}}></div></div>`;
}

// ── APP (reactive core) ───────────────────────────────────────
function App(){
  const [sessions,setSessions]=useState([]);
  const [activeId,setActiveId]=useState(null);
  const [session,setSession]=useState(null);
  const [running,setRunning]=useState(false);
  const [streamBlocks,setStreamBlocks]=useState([]);
  const esRef=useRef(null);
  const listRef=useRef(null);

  const loadSessions=useCallback(async()=>{ const d=await api("GET","/api/sessions").catch(()=>null); if(d) setSessions(d); },[]);
  const select=useCallback(async(id)=>{
    setActiveId(id); history.replaceState(null,"",`?session=${id}`);
    const d=await api("GET",`/api/sessions/${id}`).catch(()=>null);
    if(d){ setSession(d); setRunning(d.status==="running"); setStreamBlocks(d.streaming||[]); }
  },[]);

  useEffect(()=>{ loadSessions(); const id=new URLSearchParams(location.search).get("session"); if(id) select(id); },[]);

  // SSE for active session + global session_update
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
          setStreamBlocks(prev=>{
            // append to last block of same kind
            const kind=ev.type==="thinking"?"thinking":"content";
            const copy=[...prev];
            for(let i=copy.length-1;i>=0;i--){ if(copy[i].kind==="tool") break; if(copy[i].kind===kind){ copy[i]={...copy[i], text: copy[i].text+ev.text}; return copy; } }
            return [...copy, {kind, text: ev.text}];
          });
        } else if(ev.type==="tool_start") setStreamBlocks(p=>[...p,{kind:"tool", call:ev.call}]);
        else if(ev.type==="tool_end") setStreamBlocks(p=>p.map(b=> b.kind==="tool"&&b.call.id===ev.id ? {...b, call:{...b.call, status:ev.status, result:ev.result?.content}}:b));
        else if(ev.type==="assistant_message"){ setSession(prev=> prev?{...prev, messages:[...prev.messages, {role:"assistant", blocks: streamBlocks}]}:prev); setStreamBlocks([]); }
        else if(ev.type==="end"){ setRunning(false); setStreamBlocks([]); api("GET",`/api/sessions/${activeId}`).then(d=>d&&setSession(d)); loadSessions(); }
        else if(ev.type==="session_update") setSessions(prev=>prev.map(s=> s.id===ev.session.id?{...s,...ev.session}:s));
      }catch{}
    };
    es.onerror=()=>{};
    return()=>es.close();
  },[activeId]);

  // auto-scroll
  useEffect(()=>{ if(listRef.current) listRef.current.scrollTop=listRef.current.scrollHeight; },[session?.messages, streamBlocks]);

  // Agent can edit this UI's files (write to ~/.cast/ui/{{UI_NAME}}/*) — auto-reload when server broadcasts ui_change
  useEffect(()=>{
    let timer=null;
    const es=new EventSource('/api/uis/events');
    es.onmessage=e=>{
      try{
        const ev=JSON.parse(e.data);
        if(ev.type==='ui_change'){
          if(timer) clearTimeout(timer);
          timer=setTimeout(()=>location.reload(), 300);
        }
      }catch{}
    };
    return()=>{ es.close(); if(timer) clearTimeout(timer); };
  },[]);

  const send=useCallback(async(text)=>{
    let id=activeId;
    if(!id){
      // first message creates session (like default UI's draft)
      const persona="senior";
      const r=await api("POST","/api/sessions",{persona});
      id=r.id; setActiveId(id); history.replaceState(null,"",`?session=${id}`); await loadSessions();
      const d=await api("GET",`/api/sessions/${id}`); setSession(d);
    }
    // optimistic user row
    setSession(prev=> prev?{...prev, messages:[...prev.messages, {role:"user", content:text}]}:prev);
    setRunning(true);
    await api("POST",`/api/sessions/${id}/chat`,{text}).catch(()=>setRunning(false));
  },[activeId]);

  const msgs = session?.messages?.filter(m=>m.role!=="system") || [];

  return html`<div class="ui-root layout-${LAYOUT.sidebar}">
    ${LAYOUT.sidebar!=="no-sidebar" ? html`<${Sidebar} sessions=${sessions} activeId=${activeId} onSelect=${select} onNew=${()=>{setActiveId(null); setSession(null); history.replaceState(null,"","/ui/{{UI_NAME}}/")}} />` : null}
    <main class="ui-main">
      <header class="ui-header">
        <span class="ui-logo" style="color:${THEME.accent}">{{UI_NAME}}</span>
        <span class="ui-status">${running?"● running":"○ idle"}</span>
        <a href="/" style="margin-left:auto;color:var(--text-muted);font-size:.8rem">default UI →</a>
      </header>
      <div class="ui-messages" ref=${listRef}>
        ${msgs.length===0? html`<div class="ui-empty">Ready — type below. Edit <code>app.js: LAYOUT</code> to rearrange.</div>` : msgs.map(m=> html`<${Message} msg=${m} />`)}
        ${streamBlocks.length>0? html`<div class="ui-stream">${streamBlocks.map(b=> html`<${Message} msg=${{role:"assistant", blocks:[b]}} />`)}</div>` : null}
      </div>
      <${Composer} onSend=${send} disabled=${!session && !activeId && false} />
    </main>
  </div>`;
}

render(html`<${App} />`, document.getElementById("app"));

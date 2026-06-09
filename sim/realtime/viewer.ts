import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { requireApiKey } from '../lib/env';
import { runAudioConversation } from './audioConvo';
import { scenarios } from './runAudio';

/**
 * Live web viewer for the simulated audio call. Runs a scenario against the real
 * gpt-realtime model and streams the conversation (transcript + audio) to the browser
 * over SSE, so you can WATCH and HEAR the call happen turn by turn.
 *
 *   npm run sim:watch     →  open http://localhost:4400
 */

const apiKey = requireApiKey();
const PORT = 4400;

function sse(res: ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  return (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>IVR Call Viewer</title>
<style>
  :root { --pm:#0051a5; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#f1f5f9; color:#0f172a; }
  header { background:var(--pm); color:#fff; padding:16px 24px; display:flex; align-items:center; gap:16px; }
  header h1 { font-size:18px; margin:0; font-weight:700; }
  header .sub { color:#bfdbfe; font-size:13px; }
  .wrap { max-width:760px; margin:24px auto; padding:0 16px; }
  .controls { display:flex; gap:12px; align-items:center; background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px; box-shadow:0 1px 2px rgba(0,0,0,.04); }
  select { flex:1; padding:9px 10px; border:1px solid #cbd5e1; border-radius:8px; font-size:14px; }
  button { background:#16a34a; color:#fff; border:0; padding:10px 18px; border-radius:8px; font-weight:600; font-size:14px; cursor:pointer; }
  button:disabled { background:#94a3b8; cursor:not-allowed; }
  .status { margin:14px 2px; font-size:13px; color:#475569; min-height:18px; display:flex; align-items:center; gap:8px; }
  .dot { width:9px; height:9px; border-radius:50%; background:#94a3b8; }
  .dot.live { background:#16a34a; animation:pulse 1s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  .feed { display:flex; flex-direction:column; gap:12px; margin-top:8px; }
  .row { display:flex; }
  .row.agent { justify-content:flex-start; }
  .row.patient { justify-content:flex-end; }
  .bubble { max-width:78%; padding:10px 14px; border-radius:14px; font-size:14px; line-height:1.45; box-shadow:0 1px 2px rgba(0,0,0,.05); animation:in .25s ease; }
  @keyframes in { from{opacity:0; transform:translateY(6px)} to{opacity:1; transform:none} }
  .agent .bubble { background:#fff; border:1px solid #dbeafe; border-bottom-left-radius:4px; }
  .patient .bubble { background:#dcfce7; border:1px solid #bbf7d0; border-bottom-right-radius:4px; }
  .who { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; margin-bottom:3px; }
  .agent .who { color:var(--pm); }
  .patient .who { color:#15803d; }
  .meta { font-size:11px; color:#64748b; margin-top:4px; }
  .speaking { outline:2px solid #16a34a55; }
  .end { text-align:center; color:#64748b; font-size:13px; margin:18px 0; }
</style>
</head>
<body>
<header>
  <div>🎙️</div>
  <div>
    <h1>IVR Simulated Call Viewer</h1>
    <div class="sub">Live audio call against the real gpt-realtime model</div>
  </div>
</header>
<div class="wrap">
  <div class="controls">
    <select id="scenario"></select>
    <button id="start">▶ Start call</button>
  </div>
  <div class="status"><span class="dot" id="dot"></span><span id="statusText">Pick a scenario and press start.</span></div>
  <div class="feed" id="feed"></div>
</div>
<script>
const feed = document.getElementById('feed');
const statusText = document.getElementById('statusText');
const dot = document.getElementById('dot');
const startBtn = document.getElementById('start');
const sel = document.getElementById('scenario');

fetch('/scenarios').then(r=>r.json()).then(list=>{
  for (const s of list) { const o=document.createElement('option'); o.value=s.name; o.textContent=s.name+' ('+s.turns+' turns)'; sel.appendChild(o); }
});

const audioCtx = new (window.AudioContext||window.webkitAudioContext)();
let queue = [];      // {role, text, meta, buffer}
let playing = false;

function b64ToBytes(b64){ const bin=atob(b64); const a=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i); return a; }
function pcm16ToBuffer(b64){
  const bytes=b64ToBytes(b64); const view=new DataView(bytes.buffer);
  const n=Math.floor(bytes.length/2); const buf=audioCtx.createBuffer(1,n,24000); const ch=buf.getChannelData(0);
  for(let i=0;i<n;i++){ ch[i]=view.getInt16(i*2,true)/32768; } return buf;
}
async function wavToBuffer(b64){ const bytes=b64ToBytes(b64); return await audioCtx.decodeAudioData(bytes.buffer.slice(0)); }

function addBubble(role, text, meta){
  const row=document.createElement('div'); row.className='row '+role;
  const b=document.createElement('div'); b.className='bubble';
  const who=document.createElement('div'); who.className='who'; who.textContent = role==='agent'?'Agent':'Patient';
  const t=document.createElement('div'); t.textContent=text;
  b.appendChild(who); b.appendChild(t);
  if(meta){ const m=document.createElement('div'); m.className='meta'; m.textContent=meta; b.appendChild(m); }
  row.appendChild(b); feed.appendChild(row); window.scrollTo(0,document.body.scrollHeight);
  return b;
}

function playNext(){
  if(playing) return;
  const item=queue.shift();
  if(!item){ playing=false; return; }
  playing=true;
  const bubble=addBubble(item.role, item.text, item.meta);
  bubble.classList.add('speaking');
  const finishItem=()=>{ bubble.classList.remove('speaking'); playing=false; playNext(); };
  if(item.buffer){
    const src=audioCtx.createBufferSource(); src.buffer=item.buffer; src.connect(audioCtx.destination);
    src.onended=finishItem; src.start();
  } else { setTimeout(finishItem, 600); }
}

function enqueue(item){ queue.push(item); playNext(); }

startBtn.onclick=()=>{
  audioCtx.resume();
  feed.innerHTML=''; queue=[]; playing=false;
  startBtn.disabled=true; sel.disabled=true;
  dot.className='dot live'; statusText.textContent='Starting…';
  const es=new EventSource('/run?scenario='+encodeURIComponent(sel.value));
  es.onmessage=async (ev)=>{
    const e=JSON.parse(ev.data);
    if(e.type==='status'){ statusText.textContent=e.text; }
    else if(e.type==='agent'){ const buffer=e.audioPcmB64?pcm16ToBuffer(e.audioPcmB64):null; enqueue({role:'agent',text:e.text,meta:e.latencyMs?('responded in '+e.latencyMs+' ms'):null,buffer}); }
    else if(e.type==='patient'){ const buffer=e.audioWavB64?await wavToBuffer(e.audioWavB64):null; enqueue({role:'patient',text:e.text,buffer}); }
    else if(e.type==='done'){ es.close(); statusText.textContent = e.reachedGoodbye?'Call completed ✓':'Call ended'; dot.className='dot'; startBtn.disabled=false; sel.disabled=false; const d=document.createElement('div'); d.className='end'; d.textContent='— end of call —'; feed.appendChild(d); }
  };
  es.onerror=()=>{ statusText.textContent='Stream error (see terminal)'; dot.className='dot'; startBtn.disabled=false; sel.disabled=false; es.close(); };
};
</script>
</body>
</html>`;

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    return;
  }

  if (url.pathname === '/scenarios') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify(scenarios.map((s) => ({ name: s.name, turns: s.patientTurns.length }))),
    );
    return;
  }

  if (url.pathname === '/run') {
    const name = url.searchParams.get('scenario');
    const scenario = scenarios.find((s) => s.name === name) || scenarios[0];
    const write = sse(res);
    console.log(`▶ running "${scenario.name}" for viewer`);
    try {
      await runAudioConversation(apiKey, scenario.patientTurns, {
        clipsDir: resolve(process.cwd(), 'sim/realtime/clips', scenario.name),
        onEvent: (e) => write(e),
      });
    } catch (err) {
      write({ type: 'status', text: 'Error: ' + (err instanceof Error ? err.message : String(err)) });
      write({ type: 'done', reachedGoodbye: false });
    }
    res.end();
    return;
  }

  res.writeHead(404).end('not found');
}

const server = createServer(handle);

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n⚠️  Port ${PORT} is already in use — the viewer may already be running.\n   Open http://localhost:${PORT} , or stop the other instance and retry.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n🎬 Call viewer running — ${url}\n   (Ctrl+C to stop)\n`);
  // Auto-open the default browser so it's effectively one-click.
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  import('node:child_process').then(({ exec }) => exec(`${opener} ${url}`, () => {})).catch(() => {});
});

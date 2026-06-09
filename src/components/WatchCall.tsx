import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Play, Loader2, Eye } from 'lucide-react';
import { TranscriptEntry, LatencyInfo, FlowMap as FlowMapType } from '../types';
import { defaultFlowMap, inferFlowStep, getSystemPrompt } from '../utils/scripts';
import { buildFullSystemPrompt } from '../utils/basePrompt';
import { SavedScript } from './ScriptConfig';
import { FlowMap } from './FlowMap';
import { Transcript } from './Transcript';
import { LatencyTracker } from './LatencyTracker';

const SAVED_SCRIPTS_KEY = 'ivr-saved-scripts';
const ED_ID = 'ed-followup-v1';

type QueueItem = { role: 'agent' | 'patient'; text: string; pcmB64: string; latencyMs: number | null };

/**
 * "Watch a Call" — plays back a SIMULATED call (an LLM-driven patient talking to the real
 * gpt-realtime agent) for any of the same scripts available in "Conduct a Call". Shows the
 * script's flow tree + live transcript + latency, with the matched option highlighted green
 * as the patient answers — driven by inferFlowStep + /api/match, exactly like a real call.
 */
export function WatchCall() {
  const [savedScripts, setSavedScripts] = useState<SavedScript[]>([]);
  const [scriptId, setScriptId] = useState(ED_ID);
  const [patientName, setPatientName] = useState('');
  const [running, setRunning] = useState(false);
  const [statusText, setStatusText] = useState('Pick a script and press "Watch call".');

  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [currentStepId, setCurrentStepId] = useState<string | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  const [matchedOptions, setMatchedOptions] = useState<Map<string, string>>(new Map());
  const [latency, setLatency] = useState<LatencyInfo>({ lastTurnMs: null, avgMs: null, turnCount: 0 });

  const abortRef = useRef<AbortController | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const playingRef = useRef(false);
  const transcriptsRef = useRef<TranscriptEntry[]>([]);
  const currentStepIdRef = useRef<string | null>(null);
  const latenciesRef = useRef<number[]>([]);
  const flowMapRef = useRef<FlowMapType>(defaultFlowMap);

  // Load saved scripts (same store the "Conduct a Call" config uses).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_SCRIPTS_KEY);
      if (raw) setSavedScripts(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => () => { abortRef.current?.abort(); audioCtxRef.current?.close().catch(() => {}); }, []);

  // The flow map shown in the tree depends on which script is selected.
  const activeFlowMap = useMemo<FlowMapType>(() => {
    if (scriptId === ED_ID) return defaultFlowMap;
    const s = savedScripts.find((x) => x.id === scriptId);
    return s?.flowMap || { title: s?.name || 'Script', steps: [] };
  }, [scriptId, savedScripts]);

  // Build the agent instructions for the selected script (same prompt as a real call).
  const buildInstructions = (): string => {
    const name = patientName.trim() || 'Maria';
    const sub = (t: string) =>
      t.replace(/\[patient_name\]/gi, name).replace(/\[[a-z0-9_]+\]/gi, '').replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim();
    if (scriptId === ED_ID) return sub(getSystemPrompt(ED_ID));
    const s = savedScripts.find((x) => x.id === scriptId);
    if (!s) return sub(getSystemPrompt(ED_ID));
    return buildFullSystemPrompt(sub(s.generatedScriptContent || ''), sub(s.generatedGreeting || ''), s.flowMap || undefined);
  };

  const pcmToBuffer = (ctx: AudioContext, b64: string): AudioBuffer => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const n = Math.floor(bytes.length / 2);
    const buf = ctx.createBuffer(1, Math.max(1, n), 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    return buf;
  };

  const addTranscript = (role: 'user' | 'assistant', text: string) => {
    const entry: TranscriptEntry = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, role, text, timestamp: new Date() };
    transcriptsRef.current = [...transcriptsRef.current, entry];
    setTranscripts(transcriptsRef.current);
  };

  const advanceFlowFromAgent = () => {
    const newStep = inferFlowStep(transcriptsRef.current.map((t) => ({ role: t.role, text: t.text })), flowMapRef.current);
    const prev = currentStepIdRef.current;
    if (newStep && newStep !== prev) {
      if (prev) setCompletedSteps((c) => new Set([...c, prev]));
      currentStepIdRef.current = newStep;
      setCurrentStepId(newStep);
    }
  };

  const matchPatientAnswer = async (userText: string) => {
    const stepId = currentStepIdRef.current;
    if (!stepId) return;
    const step = flowMapRef.current.steps.find((s) => s.id === stepId);
    if (!step || step.options.length < 2) return;
    try {
      const transcriptSoFar = transcriptsRef.current.map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`).join('\n');
      const res = await fetch('/api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: step.question, userResponse: userText, options: step.options, transcriptSoFar }),
      });
      if (!res.ok) return;
      const data = await res.json();
      let label: string | null = null;
      if (typeof data.matchedIndex === 'number' && data.matchedIndex >= 0 && data.matchedIndex < step.options.length) label = step.options[data.matchedIndex].label;
      else if (data.match) label = data.match;
      if (label) setMatchedOptions((prev) => new Map([...prev, [stepId, label as string]]));
    } catch { /* best-effort */ }
  };

  const playNext = useCallback(() => {
    if (playingRef.current) return;
    const item = queueRef.current.shift();
    if (!item) { playingRef.current = false; return; }
    playingRef.current = true;

    if (item.role === 'agent') {
      addTranscript('assistant', item.text);
      advanceFlowFromAgent();
      if (item.latencyMs != null) {
        latenciesRef.current.push(item.latencyMs);
        const avg = latenciesRef.current.reduce((a, b) => a + b, 0) / latenciesRef.current.length;
        setLatency({ lastTurnMs: item.latencyMs, avgMs: avg, turnCount: latenciesRef.current.length });
      }
    } else {
      addTranscript('user', item.text);
      void matchPatientAnswer(item.text);
    }

    const ctx = audioCtxRef.current;
    let advanced = false;
    const finishItem = () => { if (advanced) return; advanced = true; playingRef.current = false; playNext(); };
    if (ctx && item.pcmB64) {
      try {
        const src = ctx.createBufferSource();
        const buf = pcmToBuffer(ctx, item.pcmB64);
        src.buffer = buf;
        src.connect(ctx.destination);
        src.onended = finishItem;
        src.start();
        setTimeout(finishItem, buf.duration * 1000 + 1200);
      } catch { setTimeout(finishItem, 500); }
    } else {
      setTimeout(finishItem, 600);
    }
  }, []);

  const enqueue = (item: QueueItem) => { queueRef.current.push(item); playNext(); };

  const start = async () => {
    if (running) return;
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioCtxRef.current.resume();
    queueRef.current = [];
    playingRef.current = false;
    transcriptsRef.current = [];
    currentStepIdRef.current = null;
    latenciesRef.current = [];
    flowMapRef.current = activeFlowMap;
    setTranscripts([]);
    setCurrentStepId(null);
    setCompletedSteps(new Set());
    setMatchedOptions(new Map());
    setLatency({ lastTurnMs: null, avgMs: null, turnCount: 0 });
    setRunning(true);
    setStatusText('Starting…');

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const resp = await fetch('/api/sim-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: buildInstructions(), patientName: patientName.trim() || 'Maria' }),
        signal: ac.signal,
      });
      if (!resp.ok || !resp.body) throw new Error(`server ${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // Read the SSE stream, buffering across chunk boundaries (audio payloads are large).
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!frame.startsWith('data:')) continue;
          const e = JSON.parse(frame.slice(5).trim());
          if (e.type === 'status') setStatusText(e.text);
          else if (e.type === 'agent') enqueue({ role: 'agent', text: e.text, pcmB64: e.audioPcmB64, latencyMs: e.latencyMs ?? null });
          else if (e.type === 'patient') enqueue({ role: 'patient', text: e.text, pcmB64: e.audioPcmB64, latencyMs: null });
          else if (e.type === 'done') setStatusText(e.reachedGoodbye ? 'Call completed ✓' : 'Call ended');
        }
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setStatusText('Stream error — see console');
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const scriptOptions = [{ id: ED_ID, name: 'ED Follow-up (Standard)' }, ...savedScripts.map((s) => ({ id: s.id, name: s.name }))];

  return (
    <div>
      <div className="mb-6 bg-white rounded-lg border border-slate-200 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <Eye className="w-5 h-5 text-indigo-600" />
          <span className="font-semibold text-slate-800">Watch a Simulated Call</span>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          A simulated patient talks to the real AI agent so you can watch the flow and hear the call — no microphone needed.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-sm font-medium text-slate-700 mb-1">Script</label>
            <select
              value={scriptId}
              onChange={(e) => setScriptId(e.target.value)}
              disabled={running}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-100"
            >
              {scriptOptions.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
            </select>
          </div>
          <div className="w-44">
            <label className="block text-sm font-medium text-slate-700 mb-1">Patient name (optional)</label>
            <input
              value={patientName}
              onChange={(e) => setPatientName(e.target.value)}
              disabled={running}
              placeholder="Maria"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-100"
            />
          </div>
          <button
            onClick={start}
            disabled={running}
            className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
          >
            {running ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
            {running ? 'Watching…' : 'Watch call'}
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2 text-sm">
          <span className="relative flex h-2.5 w-2.5">
            {running && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />}
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${running ? 'bg-indigo-500' : 'bg-slate-300'}`} />
          </span>
          <span className="text-slate-600">{statusText}</span>
        </div>
        {savedScripts.length === 0 && (
          <p className="mt-2 text-xs text-slate-400">Tip: generate &amp; <b>Save</b> a script in "Conduct a Call" and it will appear here too.</p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-indigo-50 rounded-lg border border-indigo-200 p-4 flex items-center text-sm text-indigo-700">
          🔊 Audio plays through your speakers — agent (AI) and patient (simulated) voices.
        </div>
        <LatencyTracker latency={latency} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <FlowMap
          flowMap={activeFlowMap}
          currentStepId={currentStepId}
          completedSteps={completedSteps}
          matchedOptions={matchedOptions}
          editable={false}
          onFlowMapChange={() => {}}
        />
        <Transcript entries={transcripts} />
      </div>
    </div>
  );
}

import { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Loader2, Eye } from 'lucide-react';
import { TranscriptEntry, LatencyInfo } from '../types';
import { defaultFlowMap, inferFlowStep } from '../utils/scripts';
import { FlowMap } from './FlowMap';
import { Transcript } from './Transcript';
import { LatencyTracker } from './LatencyTracker';

interface ScenarioInfo {
  name: string;
  label: string;
  turns: number;
}

type QueueItem = { role: 'agent' | 'patient'; text: string; pcmB64: string; latencyMs: number | null };

/**
 * "Watch a Call" — plays back a SIMULATED call (a scripted patient talking to the real
 * gpt-realtime agent) streamed from /api/sim-run. Shows the same flow tree + live
 * transcript + latency as a real call, with the matched option highlighted green as the
 * (simulated) patient answers — driven by inferFlowStep + /api/match, exactly like the
 * real call does.
 */
export function WatchCall() {
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [scenario, setScenario] = useState('cooperative-home');
  const [patientName, setPatientName] = useState('');
  const [running, setRunning] = useState(false);
  const [statusText, setStatusText] = useState('Pick a scenario and press "Watch call".');

  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [currentStepId, setCurrentStepId] = useState<string | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  const [matchedOptions, setMatchedOptions] = useState<Map<string, string>>(new Map());
  const [latency, setLatency] = useState<LatencyInfo>({ lastTurnMs: null, avgMs: null, turnCount: 0 });

  const esRef = useRef<EventSource | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const playingRef = useRef(false);
  const transcriptsRef = useRef<TranscriptEntry[]>([]);
  const currentStepIdRef = useRef<string | null>(null);
  const latenciesRef = useRef<number[]>([]);

  useEffect(() => {
    fetch('/api/sim-run?list')
      .then((r) => r.json())
      .then((list) => setScenarios(list))
      .catch(() => setScenarios([]));
  }, []);

  useEffect(() => () => { esRef.current?.close(); audioCtxRef.current?.close().catch(() => {}); }, []);

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
    return entry;
  };

  // When the agent speaks, advance the flow tree (same logic as App.tsx).
  const advanceFlowFromAgent = () => {
    const newStep = inferFlowStep(transcriptsRef.current.map((t) => ({ role: t.role, text: t.text })), defaultFlowMap);
    const prev = currentStepIdRef.current;
    if (newStep && newStep !== prev) {
      if (prev) setCompletedSteps((c) => new Set([...c, prev]));
      currentStepIdRef.current = newStep;
      setCurrentStepId(newStep);
    }
  };

  // When the patient answers, match it to an option and highlight it green (via /api/match).
  const matchPatientAnswer = async (userText: string) => {
    const stepId = currentStepIdRef.current;
    if (!stepId) return;
    const step = defaultFlowMap.steps.find((s) => s.id === stepId);
    if (!step || step.options.length < 2) return;
    try {
      const transcriptSoFar = transcriptsRef.current
        .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`)
        .join('\n');
      const res = await fetch('/api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: step.question, userResponse: userText, options: step.options, transcriptSoFar }),
      });
      if (!res.ok) return;
      const data = await res.json();
      let label: string | null = null;
      if (typeof data.matchedIndex === 'number' && data.matchedIndex >= 0 && data.matchedIndex < step.options.length) {
        label = step.options[data.matchedIndex].label;
      } else if (data.match) {
        label = data.match;
      }
      if (label) setMatchedOptions((prev) => new Map([...prev, [stepId, label as string]]));
    } catch {
      /* matching is best-effort */
    }
  };

  const playNext = useCallback(() => {
    if (playingRef.current) return;
    const item = queueRef.current.shift();
    if (!item) { playingRef.current = false; return; }
    playingRef.current = true;

    // Reveal the bubble + update the flow tree in sync with the audio.
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
        // Safety: advance even if onended never fires (e.g. headless / suspended ctx).
        setTimeout(finishItem, buf.duration * 1000 + 1200);
      } catch { setTimeout(finishItem, 500); }
    } else {
      setTimeout(finishItem, 600);
    }
  }, []);

  const enqueue = (item: QueueItem) => { queueRef.current.push(item); playNext(); };

  const start = () => {
    if (running) return;
    // Reset
    if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioCtxRef.current.resume();
    queueRef.current = [];
    playingRef.current = false;
    transcriptsRef.current = [];
    currentStepIdRef.current = null;
    latenciesRef.current = [];
    setTranscripts([]);
    setCurrentStepId(null);
    setCompletedSteps(new Set());
    setMatchedOptions(new Map());
    setLatency({ lastTurnMs: null, avgMs: null, turnCount: 0 });
    setRunning(true);
    setStatusText('Starting…');

    const params = new URLSearchParams({ scenario });
    if (patientName.trim()) params.set('name', patientName.trim());
    const es = new EventSource(`/api/sim-run?${params.toString()}`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type === 'status') setStatusText(e.text);
      else if (e.type === 'agent') enqueue({ role: 'agent', text: e.text, pcmB64: e.audioPcmB64, latencyMs: e.latencyMs ?? null });
      else if (e.type === 'patient') enqueue({ role: 'patient', text: e.text, pcmB64: e.audioPcmB64, latencyMs: null });
      else if (e.type === 'done') {
        es.close();
        esRef.current = null;
        setStatusText(e.reachedGoodbye ? 'Call completed ✓' : 'Call ended');
        setRunning(false);
      }
    };
    es.onerror = () => { setStatusText('Stream error — see console'); es.close(); esRef.current = null; setRunning(false); };
  };

  return (
    <div>
      {/* Controls */}
      <div className="mb-6 bg-white rounded-lg border border-slate-200 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <Eye className="w-5 h-5 text-indigo-600" />
          <span className="font-semibold text-slate-800">Watch a Simulated Call</span>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          A scripted patient talks to the real AI agent so you can watch the flow and hear the call — no microphone needed.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-sm font-medium text-slate-700 mb-1">Scenario</label>
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
              disabled={running}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-100"
            >
              {scenarios.map((s) => (
                <option key={s.name} value={s.name}>{s.label} ({s.turns} turns)</option>
              ))}
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
          <span className={`relative flex h-2.5 w-2.5`}>
            {running && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />}
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${running ? 'bg-indigo-500' : 'bg-slate-300'}`} />
          </span>
          <span className="text-slate-600">{statusText}</span>
        </div>
      </div>

      {/* Latency */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-indigo-50 rounded-lg border border-indigo-200 p-4 flex items-center text-sm text-indigo-700">
          🔊 Audio plays through your speakers — agent (AI) and patient (simulated) voices.
        </div>
        <LatencyTracker latency={latency} />
      </div>

      {/* Flow tree + transcript */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <FlowMap
          flowMap={defaultFlowMap}
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

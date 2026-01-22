import { useState, useCallback } from 'react';
import { Stethoscope, AlertCircle } from 'lucide-react';
import { useRealtimeAudio } from './hooks/useRealtimeAudio';
import { TranscriptEntry, CallStatus } from './types';
import { CallControls } from './components/CallControls';
import { StatusIndicator } from './components/StatusIndicator';
import { Transcript } from './components/Transcript';
import { FlowMap } from './components/FlowMap';
import { LatencyTracker } from './components/LatencyTracker';
import { defaultFlowMap, inferFlowStep, matchUserResponse } from './utils/scripts';

function App() {
  const [patientName, setPatientName] = useState('');
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentStepId, setCurrentStepId] = useState<string | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  const [matchedOptions, setMatchedOptions] = useState<Map<string, string>>(new Map());

  // Handle new transcript entries
  const handleTranscript = useCallback((entry: TranscriptEntry) => {
    setTranscripts((prev) => [...prev, entry]);

    // Update flow tracking based on transcripts
    if (entry.role === 'assistant') {
      // Infer which step we're on based on assistant speech
      const newStep = inferFlowStep(
        [...transcripts, entry].map((t) => ({ role: t.role, text: t.text })),
        defaultFlowMap
      );
      if (newStep && newStep !== currentStepId) {
        // Mark previous step as completed
        if (currentStepId) {
          setCompletedSteps((prev) => new Set([...prev, currentStepId]));
        }
        setCurrentStepId(newStep);
      }
    } else if (entry.role === 'user' && currentStepId) {
      // Try to match user response to current step options
      const matched = matchUserResponse(entry.text, currentStepId, defaultFlowMap);
      if (matched) {
        setMatchedOptions((prev) => new Map([...prev, [currentStepId, matched]]));
      }
    }
  }, [transcripts, currentStepId]);

  // Handle status changes
  const handleStatusChange = useCallback((status: CallStatus) => {
    if (status === 'ended' || status === 'error') {
      // Reset flow tracking for next call
      // But keep transcript for review
    }
  }, []);

  // Handle errors
  const handleError = useCallback((errorMsg: string) => {
    setError(errorMsg);
  }, []);

  const { status, latency, startCall, endCall, isSupported } = useRealtimeAudio({
    onTranscript: handleTranscript,
    onStatusChange: handleStatusChange,
    onError: handleError,
  });

  // Start a new call
  const handleStartCall = useCallback(() => {
    setError(null);
    setTranscripts([]);
    setCurrentStepId(null);
    setCompletedSteps(new Set());
    setMatchedOptions(new Map());
    startCall(patientName || undefined);
  }, [patientName, startCall]);

  // End current call
  const handleEndCall = useCallback(() => {
    endCall();
  }, [endCall]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-[#0051a5] text-white shadow-md">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-white/10 rounded-lg flex items-center justify-center">
              <Stethoscope className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Penn Medicine Lancaster General Health</h1>
              <p className="text-blue-200 text-sm">
                Emergency Department Follow-Up Call System
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-6 py-6">
        {/* Error banner */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-red-800">Error</h3>
              <p className="text-red-700 text-sm">{error}</p>
            </div>
            <button
              onClick={() => setError(null)}
              className="ml-auto text-red-600 hover:text-red-800"
            >
              ×
            </button>
          </div>
        )}

        {/* Call controls */}
        <div className="mb-6">
          <CallControls
            status={status}
            patientName={patientName}
            onPatientNameChange={setPatientName}
            onStartCall={handleStartCall}
            onEndCall={handleEndCall}
            isSupported={isSupported}
          />
        </div>

        {/* Status and Latency row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <StatusIndicator status={status} />
          <LatencyTracker latency={latency} />
        </div>

        {/* Main content grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Flow Map */}
          <FlowMap
            flowMap={defaultFlowMap}
            currentStepId={currentStepId}
            completedSteps={completedSteps}
            matchedOptions={matchedOptions}
          />

          {/* Transcript */}
          <Transcript entries={transcripts} />
        </div>

        {/* Instructions */}
        <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <h3 className="font-semibold text-blue-800 mb-2">How to use</h3>
          <ol className="list-decimal list-inside text-blue-700 text-sm space-y-1">
            <li>Enter the patient's name (optional) and click "Start Call"</li>
            <li>Allow microphone access when prompted</li>
            <li>The AI assistant will begin the IVR script</li>
            <li>Speak your responses naturally - the system understands variations</li>
            <li>The call will end automatically after the closing, or click "End Call"</li>
          </ol>
          <p className="mt-3 text-xs text-blue-600">
            Note: This requires HTTPS in production. For local development, use <code className="bg-blue-100 px-1 rounded">vercel dev</code> which handles this automatically.
          </p>
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-auto py-4 text-center text-sm text-slate-500">
        <p>Penn Medicine IVR Voice Assistant - WebRTC Demo</p>
      </footer>
    </div>
  );
}

export default App;

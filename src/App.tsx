import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Stethoscope, AlertCircle } from 'lucide-react';
import { useRealtimeAudio } from './hooks/useRealtimeAudio';
import { TranscriptEntry, CallStatus, FlowMap as FlowMapType, CallSummaryData } from './types';
import { CallControls } from './components/CallControls';
import { StatusIndicator } from './components/StatusIndicator';
import { Transcript } from './components/Transcript';
import { FlowMap } from './components/FlowMap';
import { LatencyTracker } from './components/LatencyTracker';
import { CallSummary } from './components/CallSummary';
import { CallbackAlert, checkAssistantForCallback } from './components/CallbackAlert';
import { ScriptConfig, ScriptSettings, ScriptMode, InputType } from './components/ScriptConfig';
import { defaultFlowMap, inferFlowStep, matchUserResponse, getSystemPrompt } from './utils/scripts';
import { buildFullSystemPrompt } from './utils/basePrompt';

function App() {
  const [patientName, setPatientName] = useState('');
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentStepId, setCurrentStepId] = useState<string | null>(null);
  const currentStepIdRef = useRef<string | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  const [matchedOptions, setMatchedOptions] = useState<Map<string, string>>(new Map());
  
  // Keep ref in sync with state for use in callbacks
  useEffect(() => {
    currentStepIdRef.current = currentStepId;
  }, [currentStepId]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [callSummary, setCallSummary] = useState<CallSummaryData | null>(null);
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  
  // Custom flow map for generated scripts
  const [customFlowMap, setCustomFlowMap] = useState<FlowMapType | null>(null);
  
  // Callback tracking - flags when clinical team needs to follow up
  const [needsCallback, setNeedsCallback] = useState(false);
  const [callbackReasons, setCallbackReasons] = useState<string[]>([]);

  // Script configuration state
  const [scriptSettings, setScriptSettings] = useState<ScriptSettings>({
    mode: 'deterministic',
    scriptChoice: 'ed-followup-v1',
    customScript: '',
    inputType: 'script',
    generatedScriptContent: null,
    generatedGreeting: null,
    voice: 'cedar', // Default voice from voice5.py
  });

  // Active flow map - use custom if available and selected, otherwise default
  const activeFlowMap = useMemo(() => {
    if (scriptSettings.scriptChoice === 'custom' && customFlowMap) {
      return customFlowMap;
    }
    return defaultFlowMap;
  }, [scriptSettings.scriptChoice, customFlowMap]);

  // LLM-based answer matching (same as voice5.py match_answer_with_llm)
  const matchAnswerWithLLM = useCallback(async (
    question: string,
    userResponse: string,
    stepId: string,
    flowMap: FlowMapType
  ) => {
    const step = flowMap.steps.find(s => s.id === stepId);
    if (!step || !step.options.length) return;

    try {
      const response = await fetch('/api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          userResponse,
          options: step.options,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.match) {
          setMatchedOptions(prev => new Map([...prev, [stepId, data.match]]));
        }
      }
    } catch (err) {
      // Fall back to local matching on error
      console.error('LLM match error:', err);
    }
  }, []);

  // Generate call summary (same as voice5.py generate_call_summary)
  const generateCallSummary = useCallback(async (
    timeline: TranscriptEntry[],
    callbackNeeded: boolean,
    reasons: string[]
  ) => {
    if (timeline.length === 0) {
      setCallSummary({
        outcome: 'incomplete',
        callbackNeeded: false,
        patientResponses: [],
        keyFindings: 'No conversation recorded.',
        language: 'Unknown'
      });
      return;
    }

    setIsSummaryLoading(true);
    try {
      const response = await fetch('/api/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          timeline,
          needsCallback: callbackNeeded,
          callbackReasons: reasons,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setCallSummary(data.summary);
      } else {
        setCallSummary({
          outcome: 'completed',
          callbackNeeded: callbackNeeded,
          patientResponses: [],
          keyFindings: 'Call completed. Unable to generate detailed summary.',
          language: 'Unknown'
        });
      }
    } catch (err) {
      console.error('Summary generation error:', err);
      setCallSummary({
        outcome: 'completed',
        callbackNeeded: callbackNeeded,
        patientResponses: [],
        keyFindings: 'Call completed. Unable to generate detailed summary.',
        language: 'Unknown'
      });
    } finally {
      setIsSummaryLoading(false);
    }
  }, []);

  // Handle new transcript entries
  const handleTranscript = useCallback((entry: TranscriptEntry) => {
    setTranscripts((prev) => {
      const updated = [...prev, entry];

      // Update flow tracking based on transcripts
      if (entry.role === 'assistant') {
        // Check if assistant confirmed a callback is needed
        // This is triggered when the model says "we'll have someone call you back"
        const callbackCheck = checkAssistantForCallback(entry.text);
        if (callbackCheck.needed && callbackCheck.reason) {
          setNeedsCallback(true);
          setCallbackReasons(prevReasons => {
            if (!prevReasons.includes(callbackCheck.reason!)) {
              return [...prevReasons, callbackCheck.reason!];
            }
            return prevReasons;
          });
        }
        
        // Infer which step we're on based on assistant speech
        const newStep = inferFlowStep(
          updated.map((t) => ({ role: t.role, text: t.text })),
          activeFlowMap
        );
        // Use ref for latest value (avoid stale closure)
        const prevStepId = currentStepIdRef.current;
        if (newStep && newStep !== prevStepId) {
          // Mark previous step as completed
          if (prevStepId) {
            setCompletedSteps((prevCompleted) => new Set([...prevCompleted, prevStepId]));
          }
          setCurrentStepId(newStep);
          currentStepIdRef.current = newStep; // Update ref immediately
        }
      } else if (entry.role === 'user') {
        // Use ref for latest step ID (handles rapid updates)
        const stepId = currentStepIdRef.current;
        if (stepId) {
          // Use LLM matching for better accuracy (async, won't block conversation)
          const step = activeFlowMap.steps.find(s => s.id === stepId);
          if (step) {
            console.log(`[match] Using LLM to match response for step ${stepId}`);
            matchAnswerWithLLM(step.question, entry.text, stepId, activeFlowMap);
          }
        }
      }

      return updated;
    });
  }, [activeFlowMap, matchAnswerWithLLM]);

  // Handle status changes
  const handleStatusChange = useCallback((newStatus: CallStatus) => {
    if (newStatus === 'ended') {
      // Generate call summary when call ends - include callback status
      setTranscripts(current => {
        // Access current callback state
        setNeedsCallback(currentNeedsCallback => {
          setCallbackReasons(currentReasons => {
            generateCallSummary(current, currentNeedsCallback, currentReasons);
            return currentReasons;
          });
          return currentNeedsCallback;
        });
        return current;
      });
    }
  }, [generateCallSummary]);

  // Handle errors
  const handleError = useCallback((errorMsg: string) => {
    setError(errorMsg);
  }, []);

  const { status, latency, startCall, endCall, isSupported } = useRealtimeAudio({
    onTranscript: handleTranscript,
    onStatusChange: handleStatusChange,
    onError: handleError,
  });

  // Generate/convert custom script - returns script content and greeting
  const handleGenerateScript = useCallback(async (
    script: string,
    inputType: InputType,
    mode: ScriptMode
  ): Promise<{ scriptContent: string; greeting: string } | null> => {
    setIsGenerating(true);
    setError(null);

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script, inputType, mode }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to generate script');
      }

      const data = await response.json();
      
      // Store the flow map if returned
      if (data.flowMap) {
        setCustomFlowMap(data.flowMap);
        console.log('[flow] Custom flow map loaded:', data.flowMap.title, 
          `with ${data.flowMap.steps?.length || 0} steps`);
      } else {
        // Clear custom flow map if none returned
        setCustomFlowMap(null);
      }
      
      return {
        scriptContent: data.scriptContent || '',
        greeting: data.greeting || 'Hello, this is Penn Medicine calling.',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate script';
      setError(message);
      return null;
    } finally {
      setIsGenerating(false);
    }
  }, []);

  // Get the system prompt to use for the call
  const getCallSystemPrompt = useCallback((): string => {
    // If custom script with generated content, combine with base template
    if (scriptSettings.scriptChoice === 'custom' && scriptSettings.generatedScriptContent) {
      // Get the greeting and replace patient name placeholder
      let greeting = scriptSettings.generatedGreeting || 'Hello, this is Penn Medicine calling.';
      const nameToUse = patientName?.trim() || '';
      
      // Replace [patient_name] placeholder
      greeting = greeting.replace(/\[patient_name\]/g, nameToUse);
      
      // Clean up awkward spacing if no name provided
      greeting = greeting.replace(/Hi\s+,/g, 'Hi,');
      greeting = greeting.replace(/^Hi,\s*this is/i, 'Hello, this is');
      
      // Get the script content and replace patient name there too
      let scriptContent = scriptSettings.generatedScriptContent;
      scriptContent = scriptContent.replace(/\[patient_name\]/g, nameToUse);
      
      // Build the full system prompt by combining base template + greeting + script
      return buildFullSystemPrompt(scriptContent, greeting);
    }

    // Use built-in scripts
    return getSystemPrompt(scriptSettings.scriptChoice, scriptSettings.mode, patientName || undefined);
  }, [scriptSettings, patientName]);

  // Start a new call
  const handleStartCall = useCallback(() => {
    // Validate custom script if selected
    if (scriptSettings.scriptChoice === 'custom' && !scriptSettings.generatedScriptContent) {
      setError('Please generate a script first by clicking "Generate Script" or "Convert Script"');
      return;
    }

    setError(null);
    setTranscripts([]);
    setCurrentStepId(null);
    setCompletedSteps(new Set());
    setMatchedOptions(new Map());
    setCallSummary(null);
    setNeedsCallback(false);
    setCallbackReasons([]);

    const systemPrompt = getCallSystemPrompt();
    startCall(patientName || undefined, systemPrompt, scriptSettings.voice, scriptSettings.mode);
  }, [patientName, scriptSettings, getCallSystemPrompt, startCall]);

  // End current call
  const handleEndCall = useCallback(() => {
    endCall();
  }, [endCall]);

  const isCallActive = status !== 'idle' && status !== 'ended' && status !== 'error';

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
            <div className="flex-1">
              <h3 className="font-semibold text-red-800">Error</h3>
              <p className="text-red-700 text-sm">{error}</p>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-red-600 hover:text-red-800 text-xl leading-none"
            >
              ×
            </button>
          </div>
        )}

        {/* Script Configuration */}
        <div className="mb-6">
          <ScriptConfig
            settings={scriptSettings}
            onSettingsChange={setScriptSettings}
            disabled={isCallActive}
            onGenerate={handleGenerateScript}
            isGenerating={isGenerating}
            flowMap={customFlowMap}
            onLoadFlowMap={setCustomFlowMap}
          />
        </div>

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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <StatusIndicator status={status} />
          <LatencyTracker latency={latency} />
        </div>

        {/* Callback Alert (prominent when callback needed) */}
        {(needsCallback || status === 'ended') && (
          <div className="mb-6">
            <CallbackAlert 
              needsCallback={needsCallback} 
              reasons={callbackReasons}
              callEnded={status === 'ended'}
            />
          </div>
        )}

        {/* Call Summary (shown when call ends) */}
        {(callSummary || isSummaryLoading) && (
          <div className="mb-6">
            <CallSummary summary={callSummary} isLoading={isSummaryLoading} />
          </div>
        )}

        {/* Main content grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Flow Map - uses active flow map (custom or default) */}
          <FlowMap
            flowMap={activeFlowMap}
            currentStepId={currentStepId}
            completedSteps={completedSteps}
            matchedOptions={matchedOptions}
            editable={scriptSettings.scriptChoice === 'custom' && status === 'idle'}
            onFlowMapChange={(newFlowMap) => {
              if (scriptSettings.scriptChoice === 'custom') {
                setCustomFlowMap(newFlowMap);
              }
            }}
          />

          {/* Transcript */}
          <Transcript entries={transcripts} />
        </div>

        {/* Instructions */}
        <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <h3 className="font-semibold text-blue-800 mb-2">How to use</h3>
          <ol className="list-decimal list-inside text-blue-700 text-sm space-y-1">
            <li>Choose your conversation mode (Deterministic or Explorative)</li>
            <li>Select a script and voice, or create a custom script</li>
            <li>Enter the patient's name (optional) and click "Start Call"</li>
            <li>Allow microphone access when prompted</li>
            <li>Speak your responses naturally - the system understands variations</li>
            <li>The call will end automatically after the closing, or click "End Call"</li>
          </ol>
          <div className="mt-3 pt-3 border-t border-blue-200">
            <p className="text-xs text-blue-600">
              <strong>Deterministic mode:</strong> AI follows the script exactly (temperature 0.6). Best for compliance.
            </p>
            <p className="text-xs text-blue-600 mt-1">
              <strong>Explorative mode:</strong> AI asks open-ended follow-ups (temperature 0.9). Best for gathering feedback.
            </p>
          </div>
          <p className="mt-3 text-xs text-blue-600">
            Note: This requires HTTPS in production. For local development, use <code className="bg-blue-100 px-1 rounded">vercel dev</code>.
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

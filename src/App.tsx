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
import { ScriptConfig, ScriptSettings, InputType } from './components/ScriptConfig';
import { defaultFlowMap, inferFlowStep, matchUserResponse, getSystemPrompt } from './utils/scripts';
import { buildFullSystemPrompt } from './utils/basePrompt';

function App() {
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentStepId, setCurrentStepId] = useState<string | null>(null);
  const currentStepIdRef = useRef<string | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  const [matchedOptions, setMatchedOptions] = useState<Map<string, string>>(new Map());
  
  // Keep ref in sync with state for use in callbacks
  useEffect(() => {
    currentStepIdRef.current = currentStepId;
    console.log(`[flow] Current step changed to: "${currentStepId}"`);
  }, [currentStepId]);
  
  // Debug: log matched options changes
  useEffect(() => {
    if (matchedOptions.size > 0) {
      const entries = Array.from(matchedOptions.entries());
      console.log(`[flow] Matched options updated (${entries.length} matches):`, entries.map(([k, v]) => `${k} → "${v}"`).join(', '));
    }
  }, [matchedOptions]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [callSummary, setCallSummary] = useState<CallSummaryData | null>(null);
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  
  // Custom flow map for generated scripts
  const [customFlowMap, setCustomFlowMap] = useState<FlowMapType | null>(null);
  
  // Callback tracking - flags when clinical team needs to follow up
  const [needsCallback, setNeedsCallback] = useState(false);
  const [callbackReasons, setCallbackReasons] = useState<string[]>([]);
  
  // Reminder tracking - flags when a reminder/follow-up was promised
  const [needsReminder, setNeedsReminder] = useState(false);
  const [reminderReasons, setReminderReasons] = useState<string[]>([]);
  // Monotonic call run id to prevent stale async updates between calls
  const callRunIdRef = useRef(0);

  // Script configuration state
  const [scriptSettings, setScriptSettings] = useState<ScriptSettings>({
    scriptChoice: 'ed-followup-v1',
    customScript: '',
    inputType: 'script',
    generatedScriptContent: null,
    generatedGreeting: null,
    voice: 'cedar', // Default voice from voice5.py
    variables: [],           // Variable placeholders from generated script
    variableValues: {},      // User-filled values for variables
  });

  // Substitute placeholders for UI display in flow map cards.
  // Uses the same variable source for ALL variables (patient_name, address fields, etc).
  const substituteForDisplay = useCallback((text: string): string => {
    let result = text;
    const variableValues = scriptSettings.variableValues || {};
    for (const [varName, value] of Object.entries(variableValues)) {
      if (!value) continue;
      const safeVarName = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`\\[${safeVarName}\\]`, 'gi'), value);
    }
    result = result.replace(/\[[a-z0-9_]+\]/gi, '');
    result = result.replace(/,\s*,/g, ',');
    result = result.replace(/\s{2,}/g, ' ').trim();
    return result;
  }, [scriptSettings.variableValues]);

  // Active flow map - use custom if available and selected, otherwise default
  // Apply variable substitutions so flow builder reflects entered values
  const activeFlowMap = useMemo(() => {
    const baseMap = (scriptSettings.scriptChoice === 'custom' && customFlowMap) 
      ? customFlowMap 
      : defaultFlowMap;

    return {
      ...baseMap,
      steps: baseMap.steps.map(step => ({
        ...step,
        question: substituteForDisplay(step.question),
        info: substituteForDisplay(step.info || ''),
        options: step.options.map(opt => ({
          ...opt,
          label: substituteForDisplay(opt.label),
        })),
      })),
    };
  }, [scriptSettings.scriptChoice, customFlowMap, substituteForDisplay]);

  // LLM-based answer matching (same as voice5.py match_answer_with_llm)
  const matchAnswerWithLLM = useCallback(async (
    question: string,
    userResponse: string,
    stepId: string,
    flowMap: FlowMapType
  ) => {
    const step = flowMap.steps.find(s => s.id === stepId);
    if (!step || !step.options.length) {
      console.log(`[match] Skipping match: step "${stepId}" not found or has no options`);
      return;
    }
    
    // Skip matching for statement steps (only have "continue" option)
    if (step.type === 'statement' || (step.options.length === 1 && step.options[0].label.toLowerCase() === 'continue')) {
      console.log(`[match] Skipping statement step "${stepId}"`);
      return;
    }

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
        console.log(`[match] Result for step "${stepId}":`, data.match, `(confidence: ${data.confidence})`);

        // Prefer matchedIndex because it's unambiguous and tied to the current option list.
        let matchedLabel: string | null = null;
        if (typeof data.matchedIndex === 'number' && data.matchedIndex >= 0 && data.matchedIndex < step.options.length) {
          matchedLabel = step.options[data.matchedIndex].label;
        } else if (data.match) {
          matchedLabel = data.match;
        } else {
          // Fallback: local matcher for robustness if API format drifts or LLM returns no match.
          matchedLabel = matchUserResponse(userResponse, stepId, flowMap);
          if (matchedLabel) {
            console.log(`[match] Fallback local match hit for step "${stepId}": "${matchedLabel}"`);
          }
        }

        if (matchedLabel) {
          setMatchedOptions(prev => {
            const current = prev.get(stepId);
            if (current === matchedLabel) return prev;
            console.log(`[match] ✅ Setting green highlight: step "${stepId}" → option "${matchedLabel}"`);
            return new Map([...prev, [stepId, matchedLabel]]);
          });
        } else {
          console.log(`[match] ❌ No match found for step "${stepId}", user said: "${userResponse}"`);
        }
      } else {
        console.log(`[match] ❌ Match API error: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      console.error('[match] ❌ LLM match error:', err);
    }
  }, []);

  // Generate call summary (same as voice5.py generate_call_summary)
  const generateCallSummary = useCallback(async (
    timeline: TranscriptEntry[],
    callbackNeeded: boolean,
    reasons: string[],
    callRunId: number
  ) => {
    if (timeline.length === 0) {
      if (callRunId !== callRunIdRef.current) return;
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
        if (callRunId !== callRunIdRef.current) {
          console.log('[summary] Ignoring stale summary result from previous call');
          return;
        }
        setCallSummary(data.summary);
        
        // Set reminder alerts from LLM analysis of full transcript
        const followUpActions: string[] = data.summary?.followUpActions || [];
        if (followUpActions.length > 0) {
          console.log('[reminder] LLM identified follow-up actions:', followUpActions);
          setNeedsReminder(true);
          setReminderReasons(followUpActions);
        }
      } else {
        if (callRunId !== callRunIdRef.current) return;
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
      if (callRunId !== callRunIdRef.current) return;
      setCallSummary({
        outcome: 'completed',
        callbackNeeded: callbackNeeded,
        patientResponses: [],
        keyFindings: 'Call completed. Unable to generate detailed summary.',
        language: 'Unknown'
      });
    } finally {
      if (callRunId !== callRunIdRef.current) return;
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
        console.log(`[match] User said: "${entry.text}", current step: "${stepId}"`);
        if (stepId) {
          // Use LLM matching for better accuracy (async, won't block conversation)
          const step = activeFlowMap.steps.find(s => s.id === stepId);
          if (step) {
            console.log(`[match] Matching against step "${stepId}" with ${step.options.length} options: ${step.options.map(o => o.label).join(', ')}`);
            matchAnswerWithLLM(step.question, entry.text, stepId, activeFlowMap);
          } else {
            console.log(`[match] WARNING: Step "${stepId}" not found in flow map`);
          }
        } else {
          console.log(`[match] WARNING: No current step set when user spoke`);
        }
      }

      return updated;
    });
  }, [activeFlowMap, matchAnswerWithLLM]);

  // Handle status changes
  const handleStatusChange = useCallback((newStatus: CallStatus) => {
    if (newStatus === 'ended') {
      const callRunId = callRunIdRef.current;
      // Mark current step as completed when call ends
      const finalStepId = currentStepIdRef.current;
      if (finalStepId) {
        setCompletedSteps((prevCompleted) => new Set([...prevCompleted, finalStepId]));
      }
      
      // Generate call summary when call ends - include callback status
      setTranscripts(current => {
        // Access current callback state
        setNeedsCallback(currentNeedsCallback => {
          setCallbackReasons(currentReasons => {
            generateCallSummary(current, currentNeedsCallback, currentReasons, callRunId);
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

  // Generate/convert custom script - returns script content, greeting, and variables
  const handleGenerateScript = useCallback(async (
    script: string,
    inputType: InputType
  ): Promise<{ scriptContent: string; greeting: string; variables?: string[] } | null> => {
    setIsGenerating(true);
    setError(null);

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script, inputType }),
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
      
      // Always include patient_name as the first variable
      const vars = data.variables || [];
      if (!vars.includes('patient_name')) {
        vars.unshift('patient_name');
      }
      
      return {
        scriptContent: data.scriptContent || '',
        greeting: data.greeting || 'Hello, this is Penn Medicine calling.',
        variables: vars,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate script';
      setError(message);
      return null;
    } finally {
      setIsGenerating(false);
    }
  }, []);

  // Unified variable substitution — replaces all [placeholders] with values from variableValues
  const substituteVariables = useCallback((text: string): string => {
    let result = text;
    const variableValues = scriptSettings.variableValues || {};
    for (const [varName, value] of Object.entries(variableValues)) {
      if (value) {
        result = result.replace(new RegExp(`\\[${varName}\\]`, 'gi'), value);
      }
    }
    // Remove any remaining unfilled placeholders
    result = result.replace(/\[[a-z0-9_]+\]/gi, '');
    // Clean up artifacts from removed placeholders (double commas, extra spaces)
    result = result.replace(/,\s*,/g, ',');
    result = result.replace(/\s{2,}/g, ' ').trim();
    return result;
  }, [scriptSettings.variableValues]);

  // Get the system prompt to use for the call
  const getCallSystemPrompt = useCallback((): string => {
    const variableValues = scriptSettings.variableValues || {};

    // If custom script with generated content, combine with base template
    if (scriptSettings.scriptChoice === 'custom' && scriptSettings.generatedScriptContent) {
      let greeting = substituteVariables(
        scriptSettings.generatedGreeting || 'Hello, this is Penn Medicine calling.'
      );
      let scriptContent = substituteVariables(scriptSettings.generatedScriptContent);
      
      // Debug: verify substitutions worked
      console.log(`[getCallSystemPrompt] variableValues:`, JSON.stringify(variableValues));
      console.log(`[getCallSystemPrompt] ORIGINAL greeting:`, JSON.stringify(scriptSettings.generatedGreeting?.substring(0, 150)));
      console.log(`[getCallSystemPrompt] AFTER sub greeting:`, JSON.stringify(greeting.substring(0, 150)));
      
      // Substitute variables in the flow map too so branching rules match the actual script
      let substitutedFlowMap = customFlowMap;
      if (customFlowMap) {
        substitutedFlowMap = {
          ...customFlowMap,
          steps: customFlowMap.steps.map(step => ({
            ...step,
            question: substituteVariables(step.question),
            info: substituteVariables(step.info || ''),
          })),
        };
      }
      return buildFullSystemPrompt(scriptContent, greeting, substitutedFlowMap || undefined);
    }

    // Use built-in scripts — apply variable substitution the same way
    const rawPrompt = getSystemPrompt(scriptSettings.scriptChoice);
    return substituteVariables(rawPrompt);
  }, [scriptSettings, customFlowMap, substituteVariables]);

  // Start a new call
  const handleStartCall = useCallback(() => {
    // Validate custom script if selected
    if (scriptSettings.scriptChoice === 'custom' && !scriptSettings.generatedScriptContent) {
      setError('Please generate a script first by clicking "Generate Script" or "Convert Script"');
      return;
    }

    // Start a new call run (invalidates stale async updates from prior calls)
    callRunIdRef.current += 1;
    setError(null);
    setTranscripts([]);
    setCurrentStepId(null);
    setCompletedSteps(new Set());
    setMatchedOptions(new Map());
    setCallSummary(null);
    setNeedsCallback(false);
    setCallbackReasons([]);
    setNeedsReminder(false);
    setReminderReasons([]);
    setIsSummaryLoading(false);

    const systemPrompt = getCallSystemPrompt();
    
    // Debug: log key info to verify substitutions
    console.log('[debug] ===== STARTING CALL =====');
    console.log('[debug] Variable values:', JSON.stringify(scriptSettings.variableValues));
    console.log('[debug] Prompt length:', systemPrompt.length);
    console.log('[debug] Any remaining [placeholders]:', systemPrompt.match(/\[[a-z0-9_]+\]/gi) || 'none');
    const greetingLineMatch = systemPrompt.match(/GREETING.*?\n.*?\n/s);
    console.log('[debug] Greeting in prompt:', greetingLineMatch?.[0]?.trim() || '(not found)');
    
    startCall(
      systemPrompt, 
      scriptSettings.voice, 
      scriptSettings.variableValues || {}
    );
  }, [scriptSettings, getCallSystemPrompt, startCall]);

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

        {/* Callback/Reminder Alerts (prominent when needed) */}
        {(needsCallback || needsReminder || status === 'ended') && (
          <div className="mb-6">
            <CallbackAlert 
              needsCallback={needsCallback} 
              reasons={callbackReasons}
              callEnded={status === 'ended'}
              needsReminder={needsReminder}
              reminderReasons={reminderReasons}
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
            <li>Select a script and voice, or create a custom script</li>
            <li>Fill any call variables (like patient name/address), then click "Start Call"</li>
            <li>Allow microphone access when prompted</li>
            <li>Speak your responses naturally - the system understands variations</li>
            <li>The call will end automatically after the closing, or click "End Call"</li>
          </ol>
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

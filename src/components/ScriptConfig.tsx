import { useState, useEffect } from 'react';
import { Settings, Wand2, FileText, ChevronDown, ChevronUp, Loader2, Save, Trash2 } from 'lucide-react';
import { FlowMap as FlowMapType } from '../types';

export type ScriptMode = 'deterministic';
export type InputType = 'script' | 'prompt';
export type FlowControlMode = 'llm' | 'programmatic';  // llm = LLM decides flow, programmatic = code controls flow

export interface ScriptSettings {
  mode: ScriptMode;
  scriptChoice: string;
  customScript: string;
  inputType: InputType;
  generatedScriptContent: string | null;  // Just the script steps (not full prompt)
  generatedGreeting: string | null;       // Editable first sentence
  voice: string;
  variables: string[];                    // List of variable names from generated script (e.g., ["street_address", "practice_number"])
  variableValues: Record<string, string>; // User-filled values for each variable
  flowControlMode: FlowControlMode;       // 'llm' = LLM controls flow, 'programmatic' = code controls flow with match API
}

interface GenerateResult {
  scriptContent: string;  // Just the script steps
  greeting: string;
  variables?: string[];   // List of variable placeholders (e.g., ["street_address", "practice_number"])
}

// Saved script structure for localStorage
export interface SavedScript {
  id: string;
  name: string;
  customScript: string;
  generatedScriptContent: string;
  generatedGreeting: string;
  flowMap: FlowMapType | null;
  mode: ScriptMode;
  variables: string[];
  savedAt: string;
}

const SAVED_SCRIPTS_KEY = 'ivr-saved-scripts';

interface ScriptConfigProps {
  settings: ScriptSettings;
  onSettingsChange: (settings: ScriptSettings) => void;
  disabled?: boolean;
  onGenerate?: (script: string, inputType: InputType, mode: ScriptMode) => Promise<GenerateResult | null>;
  isGenerating?: boolean;
  flowMap?: FlowMapType | null;  // Current flow map for saving
  onLoadFlowMap?: (flowMap: FlowMapType | null) => void;  // Callback to load flow map
}

const SCRIPT_OPTIONS = [
  { id: 'ed-followup-v1', name: 'ED Follow-up (Standard)' },
  { id: 'custom', name: '+ Generate New Script' },
];

// Voice options from OpenAI Realtime API
const VOICE_OPTIONS = [
  { id: 'cedar', name: 'Cedar (default)' },
  { id: 'alloy', name: 'Alloy' },
  { id: 'echo', name: 'Echo' },
  { id: 'shimmer', name: 'Shimmer' },
];

export function ScriptConfig({
  settings,
  onSettingsChange,
  disabled,
  onGenerate,
  isGenerating,
  flowMap,
  onLoadFlowMap,
}: ScriptConfigProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [savedScripts, setSavedScripts] = useState<SavedScript[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const isCustom = settings.scriptChoice === 'custom';

  // Timer for tracking generation time
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    
    if (isGenerating) {
      setElapsedSeconds(0);
      interval = setInterval(() => {
        setElapsedSeconds(prev => prev + 1);
      }, 1000);
    } else {
      setElapsedSeconds(0);
    }
    
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isGenerating]);

  // Load saved scripts from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SAVED_SCRIPTS_KEY);
      if (saved) {
        setSavedScripts(JSON.parse(saved));
      }
    } catch (e) {
      console.error('Failed to load saved scripts:', e);
    }
  }, []);

  // Save scripts to localStorage
  const persistScripts = (scripts: SavedScript[]) => {
    try {
      localStorage.setItem(SAVED_SCRIPTS_KEY, JSON.stringify(scripts));
      setSavedScripts(scripts);
    } catch (e) {
      console.error('Failed to save scripts:', e);
    }
  };

  const handleSaveScript = () => {
    if (!saveName.trim() || !settings.generatedScriptContent) return;
    
    const newScript: SavedScript = {
      id: Date.now().toString(),
      name: saveName.trim(),
      customScript: settings.customScript,
      generatedScriptContent: settings.generatedScriptContent,
      generatedGreeting: settings.generatedGreeting || '',
      flowMap: flowMap || null,
      mode: settings.mode,
      variables: settings.variables || [],
      savedAt: new Date().toISOString(),
    };
    
    persistScripts([...savedScripts, newScript]);
    setShowSaveDialog(false);
    setSaveName('');
  };

  const handleLoadScript = (script: SavedScript) => {
    onSettingsChange({
      ...settings,
      scriptChoice: 'custom',
      customScript: script.customScript,
      generatedScriptContent: script.generatedScriptContent,
      generatedGreeting: script.generatedGreeting,
      mode: script.mode,
      variables: script.variables || [],
      variableValues: {}, // Reset values when loading a new script
    });
    if (onLoadFlowMap && script.flowMap) {
      onLoadFlowMap(script.flowMap);
    }
  };

  const handleDeleteScript = (id: string) => {
    persistScripts(savedScripts.filter(s => s.id !== id));
  };

  const handleVoiceChange = (voice: string) => {
    onSettingsChange({ ...settings, voice });
  };

  const handleScriptChoiceChange = (scriptChoice: string) => {
    // Check if this is a saved script (prefixed with 'saved:')
    if (scriptChoice.startsWith('saved:')) {
      const savedId = scriptChoice.replace('saved:', '');
      const savedScript = savedScripts.find(s => s.id === savedId);
      if (savedScript) {
        handleLoadScript(savedScript);
        return;
      }
    }
    
    onSettingsChange({ 
      ...settings, 
      scriptChoice,
      generatedScriptContent: null, // Reset generated script when changing selection
      generatedGreeting: null,
    });
  };

  const handleInputTypeChange = (inputType: InputType) => {
    onSettingsChange({ ...settings, inputType });
  };

  const handleCustomScriptChange = (customScript: string) => {
    onSettingsChange({ ...settings, customScript, generatedScriptContent: null, generatedGreeting: null });
  };

  const handleGreetingChange = (greeting: string) => {
    onSettingsChange({ ...settings, generatedGreeting: greeting });
  };

  const handleGenerate = async () => {
    if (!onGenerate || !settings.customScript.trim()) return;
    
    const result = await onGenerate(settings.customScript, settings.inputType, settings.mode);
    if (result) {
      onSettingsChange({ 
        ...settings, 
        generatedScriptContent: result.scriptContent,
        generatedGreeting: result.greeting,
        variables: result.variables || [],
        variableValues: {}, // Reset variable values when regenerating
      });
    }
  };

  const handleVariableChange = (varName: string, value: string) => {
    onSettingsChange({
      ...settings,
      variableValues: {
        ...settings.variableValues,
        [varName]: value,
      },
    });
  };

  // Helper to format variable name for display
  const formatVarName = (varName: string) => {
    return varName
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-indigo-600" />
          <span className="font-semibold text-slate-800">Script Configuration</span>
        </div>
        {isExpanded ? (
          <ChevronUp className="w-5 h-5 text-slate-400" />
        ) : (
          <ChevronDown className="w-5 h-5 text-slate-400" />
        )}
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 border-t border-slate-100">
          {/* Script and Voice Selection - side by side */}
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Script
              </label>
              <select
                value={settings.scriptChoice}
                onChange={(e) => handleScriptChoiceChange(e.target.value)}
                disabled={disabled}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
              >
                {/* Built-in scripts */}
                <optgroup label="Built-in Scripts">
                  {SCRIPT_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </optgroup>
                
                {/* Saved scripts */}
                {savedScripts.length > 0 && (
                  <optgroup label="Saved Scripts">
                    {savedScripts.map((script) => (
                      <option key={script.id} value={`saved:${script.id}`}>
                        {script.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              
              {/* Delete saved script button - only show when a saved script is loaded */}
              {settings.scriptChoice === 'custom' && settings.generatedScriptContent && (
                <div className="mt-2 flex items-center gap-2">
                  {savedScripts.some(s => 
                    s.generatedScriptContent === settings.generatedScriptContent
                  ) && (
                    <button
                      onClick={() => {
                        const match = savedScripts.find(s => 
                          s.generatedScriptContent === settings.generatedScriptContent
                        );
                        if (match) handleDeleteScript(match.id);
                      }}
                      className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700"
                    >
                      <Trash2 className="w-3 h-3" />
                      Delete saved script
                    </button>
                  )}
                </div>
              )}
            </div>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Voice
              </label>
              <select
                value={settings.voice}
                onChange={(e) => handleVoiceChange(e.target.value)}
                disabled={disabled}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
              >
                {VOICE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Flow Control Mode Toggle */}
          <div className="mt-4 p-3 bg-slate-50 rounded-lg border border-slate-200">
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Flow Control Mode
            </label>
            <div className="flex gap-3">
              <label className={`flex-1 flex items-center gap-2 px-3 py-2 rounded border cursor-pointer text-sm ${
                settings.flowControlMode === 'llm'
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 hover:border-slate-300'
              }`}>
                <input
                  type="radio"
                  name="flowControlMode"
                  value="llm"
                  checked={settings.flowControlMode === 'llm'}
                  onChange={() => onSettingsChange({ ...settings, flowControlMode: 'llm' })}
                  disabled={disabled}
                  className="sr-only"
                />
                <div>
                  <div className="font-medium">LLM-Controlled</div>
                  <div className="text-xs text-slate-500">LLM decides branching (faster, less reliable)</div>
                </div>
              </label>
              
              <label className={`flex-1 flex items-center gap-2 px-3 py-2 rounded border cursor-pointer text-sm ${
                settings.flowControlMode === 'programmatic'
                  ? 'border-green-500 bg-green-50 text-green-700'
                  : 'border-slate-200 hover:border-slate-300'
              }`}>
                <input
                  type="radio"
                  name="flowControlMode"
                  value="programmatic"
                  checked={settings.flowControlMode === 'programmatic'}
                  onChange={() => onSettingsChange({ ...settings, flowControlMode: 'programmatic' })}
                  disabled={disabled}
                  className="sr-only"
                />
                <div>
                  <div className="font-medium">Programmatic</div>
                  <div className="text-xs text-slate-500">Code controls branching (+300ms, more reliable)</div>
                </div>
              </label>
            </div>
          </div>

          {/* Custom Script Input */}
          {isCustom && (
            <div className="mt-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
              {/* Input Type Selection */}
              <div className="mb-3">
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Input Type
                </label>
                <div className="flex gap-3">
                  <label className={`flex items-center gap-2 px-3 py-1.5 rounded border cursor-pointer text-sm ${
                    settings.inputType === 'script'
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}>
                    <input
                      type="radio"
                      name="inputType"
                      value="script"
                      checked={settings.inputType === 'script'}
                      onChange={() => handleInputTypeChange('script')}
                      disabled={disabled}
                      className="sr-only"
                    />
                    <FileText className="w-4 h-4" />
                    SMS/IVR Script
                  </label>
                  
                  <label className={`flex items-center gap-2 px-3 py-1.5 rounded border cursor-pointer text-sm ${
                    settings.inputType === 'prompt'
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}>
                    <input
                      type="radio"
                      name="inputType"
                      value="prompt"
                      checked={settings.inputType === 'prompt'}
                      onChange={() => handleInputTypeChange('prompt')}
                      disabled={disabled}
                      className="sr-only"
                    />
                    <Wand2 className="w-4 h-4" />
                    Open-ended Prompt
                  </label>
                </div>
              </div>

              {/* Text Input */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  {settings.inputType === 'script' 
                    ? 'Paste your SMS/IVR script' 
                    : 'Describe the conversation flow'}
                </label>
                <textarea
                  value={settings.customScript}
                  onChange={(e) => handleCustomScriptChange(e.target.value)}
                  placeholder={
                    settings.inputType === 'script'
                      ? 'Paste your existing IVR or SMS script here...\n\nExample:\n# Language Selection\nHello, this is Penn Medicine calling...\nTo continue in English, say "English"...'
                      : 'Describe what the call should accomplish...\n\nExample:\nCreate a follow-up call for patients who missed their appointment. Ask why they missed it, if they want to reschedule, and collect any concerns they have.'
                  }
                  disabled={disabled || isGenerating}
                  rows={6}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-slate-100 disabled:cursor-not-allowed text-sm font-mono"
                />
              </div>

              {/* Generate Button */}
              <div className="mt-3 flex items-center gap-3 flex-wrap">
                <button
                  onClick={handleGenerate}
                  disabled={disabled || isGenerating || !settings.customScript.trim()}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {settings.inputType === 'script' ? 'Converting...' : 'Generating...'}
                    </>
                  ) : (
                    <>
                      <Wand2 className="w-4 h-4" />
                      {settings.inputType === 'script' ? 'Convert Script' : 'Generate Script'}
                    </>
                  )}
                </button>
                
                {/* Elapsed time during generation */}
                {isGenerating && (
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-100 rounded-full">
                      <span className="font-mono font-medium text-indigo-600">{elapsedSeconds}s</span>
                    </div>
                  </div>
                )}
                
                {settings.generatedScriptContent && !isGenerating && (
                  <>
                    <span className="text-sm text-green-600 font-medium">
                      ✓ Script ready
                    </span>
                    <button
                      onClick={() => setShowSaveDialog(true)}
                      disabled={disabled}
                      className="flex items-center gap-1 px-3 py-2 text-sm text-indigo-600 hover:bg-indigo-50 rounded-lg border border-indigo-200 transition-colors"
                    >
                      <Save className="w-4 h-4" />
                      Save Script
                    </button>
                  </>
                )}
              </div>

              {/* Save Dialog */}
              {showSaveDialog && (
                <div className="mt-3 p-3 bg-indigo-50 border border-indigo-200 rounded-lg">
                  <label className="block text-sm font-medium text-indigo-700 mb-2">
                    Save script as:
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={saveName}
                      onChange={(e) => setSaveName(e.target.value)}
                      placeholder="e.g., ED Follow-up Custom"
                      className="flex-1 px-3 py-2 text-sm border border-indigo-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveScript()}
                    />
                    <button
                      onClick={handleSaveScript}
                      disabled={!saveName.trim()}
                      className="px-3 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:bg-slate-300"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setShowSaveDialog(false); setSaveName(''); }}
                      className="px-3 py-2 text-slate-600 text-sm hover:bg-slate-100 rounded-lg"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Editable Greeting */}
              {settings.generatedScriptContent && (
                <div className="mt-4 p-3 bg-white border border-slate-200 rounded-lg">
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Opening Greeting (editable)
                  </label>
                  <input
                    type="text"
                    value={settings.generatedGreeting || ''}
                    onChange={(e) => handleGreetingChange(e.target.value)}
                    disabled={disabled}
                    placeholder="Hi [patient_name], this is Penn Medicine calling..."
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-slate-100 text-sm"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Use [patient_name] as placeholder. This is the first thing the agent will say.
                  </p>
                </div>
              )}

              {/* Variable Inputs */}
              {settings.generatedScriptContent && settings.variables && settings.variables.length > 0 && (
                <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <label className="block text-sm font-medium text-amber-800 mb-3">
                    Fill in Variables
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    {settings.variables.map((varName) => (
                      <div key={varName}>
                        <label className="block text-xs font-medium text-amber-700 mb-1">
                          {formatVarName(varName)}
                        </label>
                        <input
                          type="text"
                          value={settings.variableValues[varName] || ''}
                          onChange={(e) => handleVariableChange(varName, e.target.value)}
                          disabled={disabled}
                          placeholder={`Enter ${formatVarName(varName).toLowerCase()}...`}
                          className="w-full px-2 py-1.5 text-sm border border-amber-300 rounded focus:ring-2 focus:ring-amber-500 focus:border-amber-500 disabled:bg-slate-100"
                        />
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-amber-600">
                    These values will replace [placeholders] in the script during the call.
                  </p>
                </div>
              )}

              {/* Generated Script Preview */}
              {settings.generatedScriptContent && (
                <div className="mt-4">
                  <button
                    onClick={() => setPreviewExpanded(!previewExpanded)}
                    className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-800"
                  >
                    {previewExpanded ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                    Preview generated script
                  </button>
                  
                  {previewExpanded && (
                    <pre className="mt-2 p-3 bg-white border border-slate-200 rounded text-xs text-slate-600 overflow-auto max-h-48">
                      {settings.generatedScriptContent}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  );
}

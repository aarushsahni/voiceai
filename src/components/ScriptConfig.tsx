import { useState, useEffect } from 'react';
import { Settings, Wand2, FileText, ChevronDown, ChevronUp, Loader2, Save, Trash2 } from 'lucide-react';
import { FlowMap as FlowMapType } from '../types';

export type ScriptMode = 'deterministic';
export type InputType = 'script' | 'prompt';

export interface ScriptSettings {
  mode: ScriptMode;
  scriptChoice: string;
  customScript: string;
  inputType: InputType;
  generatedScriptContent: string | null;  // Just the script steps (not full prompt)
  generatedGreeting: string | null;       // Editable first sentence
  voice: string;
}

interface GenerateResult {
  scriptContent: string;  // Just the script steps
  greeting: string;
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

  const isCustom = settings.scriptChoice === 'custom';

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
      });
    }
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
                
                {settings.generatedScriptContent && (
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

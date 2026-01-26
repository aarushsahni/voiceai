import { useState } from 'react';
import { Settings, Wand2, FileText, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

export type ScriptMode = 'deterministic' | 'explorative';
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

interface ScriptConfigProps {
  settings: ScriptSettings;
  onSettingsChange: (settings: ScriptSettings) => void;
  disabled?: boolean;
  onGenerate?: (script: string, inputType: InputType, mode: ScriptMode) => Promise<GenerateResult | null>;
  isGenerating?: boolean;
}

const SCRIPT_OPTIONS = [
  { id: 'ed-followup-v1', name: 'ED Follow-up (Standard)' },
  { id: 'ed-followup-short', name: 'ED Follow-up (Short)' },
  { id: 'custom', name: 'Custom Script' },
];

// Voice options from OpenAI (cedar is default in voice5.py)
const VOICE_OPTIONS = [
  { id: 'cedar', name: 'Cedar (default)' },
  { id: 'alloy', name: 'Alloy' },
  { id: 'echo', name: 'Echo' },
  { id: 'fable', name: 'Fable' },
  { id: 'onyx', name: 'Onyx' },
  { id: 'nova', name: 'Nova' },
  { id: 'shimmer', name: 'Shimmer' },
];

export function ScriptConfig({
  settings,
  onSettingsChange,
  disabled,
  onGenerate,
  isGenerating,
}: ScriptConfigProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [previewExpanded, setPreviewExpanded] = useState(false);

  const isCustom = settings.scriptChoice === 'custom';

  const handleModeChange = (mode: ScriptMode) => {
    onSettingsChange({ ...settings, mode });
  };

  const handleVoiceChange = (voice: string) => {
    onSettingsChange({ ...settings, voice });
  };

  const handleScriptChoiceChange = (scriptChoice: string) => {
    onSettingsChange({ 
      ...settings, 
      scriptChoice,
      generatedScriptContent: null, // Reset generated script when changing selection
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
          {/* Mode Selection */}
          <div className="mt-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Conversation Mode
            </label>
            <div className="flex gap-4">
              <label className={`flex items-center gap-2 px-4 py-2 rounded-lg border cursor-pointer transition-colors ${
                settings.mode === 'deterministic' 
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700' 
                  : 'border-slate-200 hover:border-slate-300'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
                <input
                  type="radio"
                  name="mode"
                  value="deterministic"
                  checked={settings.mode === 'deterministic'}
                  onChange={() => handleModeChange('deterministic')}
                  disabled={disabled}
                  className="sr-only"
                />
                <div>
                  <div className="font-medium">Deterministic</div>
                  <div className="text-xs text-slate-500">Follow script verbatim</div>
                </div>
              </label>
              
              <label className={`flex items-center gap-2 px-4 py-2 rounded-lg border cursor-pointer transition-colors ${
                settings.mode === 'explorative' 
                  ? 'border-indigo-500 bg-indigo-50 text-indigo-700' 
                  : 'border-slate-200 hover:border-slate-300'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
                <input
                  type="radio"
                  name="mode"
                  value="explorative"
                  checked={settings.mode === 'explorative'}
                  onChange={() => handleModeChange('explorative')}
                  disabled={disabled}
                  className="sr-only"
                />
                <div>
                  <div className="font-medium">Explorative</div>
                  <div className="text-xs text-slate-500">Natural conversation, same topics</div>
                </div>
              </label>
            </div>
          </div>

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
                {SCRIPT_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
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
              <div className="mt-3 flex items-center gap-3">
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
                  <span className="text-sm text-green-600 font-medium">
                    ✓ Script ready
                  </span>
                )}
              </div>

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

          {/* Mode Description */}
          <div className="mt-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
            <div className="text-sm text-blue-800">
              {settings.mode === 'deterministic' ? (
                <>
                  <strong>Deterministic mode:</strong> The AI will follow the script exactly as written,
                  using verbatim phrases for questions and acknowledgments. Best for compliance and consistency.
                </>
              ) : (
                <>
                  <strong>Explorative mode:</strong> The AI will follow the same topic order but can
                  ask open-ended follow-up questions and respond more naturally. Best for gathering detailed feedback.
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { GitBranch, Circle, CheckCircle2, ArrowRight, Settings, Plus, Minus, RefreshCw, Loader2, X, Check, Pencil } from 'lucide-react';
import { FlowMap as FlowMapType, FlowStep, FlowOption } from '../types';

interface FlowMapProps {
  flowMap: FlowMapType;
  currentStepId: string | null;
  completedSteps: Set<string>;
  matchedOptions: Map<string, string>;
  editable?: boolean;
  onFlowMapChange?: (flowMap: FlowMapType) => void;
}

export function FlowMap({ 
  flowMap, 
  currentStepId, 
  completedSteps, 
  matchedOptions,
  editable = false,
  onFlowMapChange,
}: FlowMapProps) {
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [regeneratingStepId, setRegeneratingStepId] = useState<string | null>(null);
  const [editingOptionIndex, setEditingOptionIndex] = useState<{ stepId: string; index: number } | null>(null);
  const [editingOptionLabel, setEditingOptionLabel] = useState('');
  const [editingOptionNext, setEditingOptionNext] = useState('');

  const getStepStatus = (step: FlowStep) => {
    if (completedSteps.has(step.id)) return 'completed';
    if (step.id === currentStepId) return 'current';
    return 'pending';
  };

  const handleRegenerateOptions = async (stepId: string, targetCount: number) => {
    const step = flowMap.steps.find(s => s.id === stepId);
    if (!step) return;

    setRegeneratingStepId(stepId);

    try {
      const response = await fetch('/api/regenerate-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: step.question,
          currentOptions: step.options,
          targetCount,
          context: step.info,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.options && Array.isArray(data.options)) {
          // Update the flow map with new options
          const updatedSteps = flowMap.steps.map(s => 
            s.id === stepId ? { ...s, options: data.options } : s
          );
          onFlowMapChange?.({ ...flowMap, steps: updatedSteps });
        }
      } else {
        console.error('Failed to regenerate options');
      }
    } catch (err) {
      console.error('Error regenerating options:', err);
    } finally {
      setRegeneratingStepId(null);
    }
  };

  const handleOptionCountChange = (stepId: string, delta: number) => {
    const step = flowMap.steps.find(s => s.id === stepId);
    if (!step) return;

    const newCount = Math.max(2, Math.min(8, step.options.length + delta));
    if (newCount !== step.options.length) {
      handleRegenerateOptions(stepId, newCount);
    }
  };

  const handleOptionSave = (stepId: string, optionIndex: number) => {
    if (!editingOptionLabel.trim()) {
      setEditingOptionIndex(null);
      return;
    }

    const updatedSteps = flowMap.steps.map(step => {
      if (step.id === stepId) {
        const updatedOptions = step.options.map((opt, idx) => 
          idx === optionIndex ? { 
            ...opt, 
            label: editingOptionLabel.trim(),
            next: editingOptionNext.trim() || opt.next,
          } : opt
        );
        return { ...step, options: updatedOptions };
      }
      return step;
    });

    onFlowMapChange?.({ ...flowMap, steps: updatedSteps });
    setEditingOptionIndex(null);
    setEditingOptionLabel('');
    setEditingOptionNext('');
  };

  const handleDeleteOption = (stepId: string, optionIndex: number) => {
    const step = flowMap.steps.find(s => s.id === stepId);
    if (!step || step.options.length <= 2) return; // Minimum 2 options

    const updatedSteps = flowMap.steps.map(s => {
      if (s.id === stepId) {
        const updatedOptions = s.options.filter((_, idx) => idx !== optionIndex);
        return { ...s, options: updatedOptions };
      }
      return s;
    });

    onFlowMapChange?.({ ...flowMap, steps: updatedSteps });
  };

  const handleAddOption = (stepId: string) => {
    const step = flowMap.steps.find(s => s.id === stepId);
    if (!step || step.options.length >= 8) return; // Maximum 8 options

    const newOption: FlowOption = {
      label: 'New option',
      keywords: [],
      next: 'continue',
    };

    const updatedSteps = flowMap.steps.map(s => {
      if (s.id === stepId) {
        return { ...s, options: [...s.options, newOption] };
      }
      return s;
    });

    onFlowMapChange?.({ ...flowMap, steps: updatedSteps });
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50">
        <div className="flex items-center gap-2">
          <GitBranch className="w-5 h-5 text-indigo-600" />
          <h2 className="font-semibold text-slate-800">{flowMap.title}</h2>
        </div>
        {editable && (
          <span className="text-xs text-slate-500 bg-slate-200 px-2 py-1 rounded">
            Click a step to edit options
          </span>
        )}
      </div>

      <div className="p-4 space-y-2 max-h-[600px] overflow-y-auto">
        {flowMap.steps.map((step, index) => {
          const status = getStepStatus(step);
          const matchedOption = matchedOptions.get(step.id);
          const isEditing = editingStepId === step.id;
          const isRegenerating = regeneratingStepId === step.id;

          return (
            <div key={step.id} className="relative">
              {/* Connector line */}
              {index < flowMap.steps.length - 1 && (
                <div 
                  className={`absolute left-4 top-10 w-0.5 h-full -translate-x-1/2 ${
                    status === 'completed' ? 'bg-green-300' : 'bg-slate-200'
                  }`}
                />
              )}

              {/* Step card */}
              <div
                className={`relative p-3 rounded-lg border transition-all ${
                  isEditing
                    ? 'border-indigo-400 bg-indigo-50 shadow-md ring-2 ring-indigo-200'
                    : status === 'current'
                    ? 'border-blue-400 bg-blue-50 shadow-md'
                    : status === 'completed'
                    ? 'border-green-300 bg-green-50'
                    : 'border-slate-200 bg-white'
                } ${editable && !isEditing ? 'cursor-pointer hover:border-indigo-300' : ''}`}
                onClick={() => editable && setEditingStepId(isEditing ? null : step.id)}
              >
                {/* Step header */}
                <div className="flex items-start gap-3">
                  <div className={`flex-shrink-0 mt-0.5 ${
                    status === 'completed' 
                      ? 'text-green-500' 
                      : status === 'current' 
                      ? 'text-blue-500' 
                      : 'text-slate-300'
                  }`}>
                    {status === 'completed' ? (
                      <CheckCircle2 className="w-5 h-5" />
                    ) : (
                      <Circle className={`w-5 h-5 ${status === 'current' ? 'fill-blue-200' : ''}`} />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`font-medium text-sm ${
                        isEditing ? 'text-indigo-700' :
                        status === 'current' ? 'text-blue-700' : 
                        status === 'completed' ? 'text-green-700' : 'text-slate-600'
                      }`}>
                        {index + 1}. {step.label}
                      </span>
                      <span className="text-xs text-slate-400">
                        {step.info}
                      </span>
                      {editable && (
                        <Settings className={`w-4 h-4 ml-auto ${isEditing ? 'text-indigo-500' : 'text-slate-300'}`} />
                      )}
                    </div>

                    {/* Question */}
                    <p className={`text-xs mt-1 ${
                      isEditing ? 'text-indigo-600' :
                      status === 'current' ? 'text-blue-600' : 'text-slate-500'
                    }`}>
                      "{step.question}"
                    </p>

                    {/* Edit controls */}
                    {isEditing && editable && (
                      <div 
                        className="mt-3 p-2 bg-white rounded border border-indigo-200"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-medium text-indigo-700">
                            Options ({step.options.length})
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleOptionCountChange(step.id, -1)}
                              disabled={step.options.length <= 2 || isRegenerating}
                              className="p-1 rounded hover:bg-indigo-100 disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Decrease options"
                            >
                              <Minus className="w-4 h-4 text-indigo-600" />
                            </button>
                            <span className="text-sm font-medium text-indigo-700 w-6 text-center">
                              {step.options.length}
                            </span>
                            <button
                              onClick={() => handleOptionCountChange(step.id, 1)}
                              disabled={step.options.length >= 8 || isRegenerating}
                              className="p-1 rounded hover:bg-indigo-100 disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Increase options"
                            >
                              <Plus className="w-4 h-4 text-indigo-600" />
                            </button>
                            <button
                              onClick={() => handleRegenerateOptions(step.id, step.options.length)}
                              disabled={isRegenerating}
                              className="ml-2 flex items-center gap-1 px-2 py-1 text-xs bg-indigo-100 text-indigo-700 rounded hover:bg-indigo-200 disabled:opacity-50"
                              title="Regenerate all options"
                            >
                              {isRegenerating ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <RefreshCw className="w-3 h-3" />
                              )}
                              Regenerate
                            </button>
                          </div>
                        </div>

                        {/* Editable options list */}
                        <div className="space-y-1">
                          {step.options.map((option, optIdx) => {
                            const isEditingThis = editingOptionIndex?.stepId === step.id && editingOptionIndex?.index === optIdx;
                            
                            return (
                              <div 
                                key={optIdx}
                                className={`p-1.5 bg-slate-50 rounded group ${isEditingThis ? 'ring-1 ring-indigo-300' : ''}`}
                              >
                                {isEditingThis ? (
                                  <div className="space-y-2">
                                    <div className="flex items-center gap-2">
                                      <label className="text-xs text-slate-500 w-12">Label:</label>
                                      <input
                                        type="text"
                                        value={editingOptionLabel}
                                        onChange={(e) => setEditingOptionLabel(e.target.value)}
                                        className="flex-1 text-xs px-2 py-1 border border-indigo-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
                                        autoFocus
                                        placeholder="Option label"
                                      />
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <label className="text-xs text-slate-500 w-12">Next:</label>
                                      <select
                                        value={editingOptionNext}
                                        onChange={(e) => setEditingOptionNext(e.target.value)}
                                        className="flex-1 text-xs px-2 py-1 border border-indigo-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
                                      >
                                        {flowMap.steps.map((s) => (
                                          <option key={s.id} value={s.id}>{s.label}</option>
                                        ))}
                                        <option value="end_call">End Call</option>
                                        <option value="schedule_callback">Schedule Callback</option>
                                        <option value="continue">Continue</option>
                                      </select>
                                    </div>
                                    <div className="flex justify-end gap-1">
                                      <button
                                        onClick={() => setEditingOptionIndex(null)}
                                        className="px-2 py-1 text-xs text-slate-600 hover:bg-slate-200 rounded"
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        onClick={() => handleOptionSave(step.id, optIdx)}
                                        className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
                                      >
                                        Save
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-2">
                                    <span className="flex-1 text-xs text-slate-700">{option.label}</span>
                                    <span className="text-xs text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">→ {option.next}</span>
                                    <button
                                      onClick={() => {
                                        setEditingOptionIndex({ stepId: step.id, index: optIdx });
                                        setEditingOptionLabel(option.label);
                                        setEditingOptionNext(option.next);
                                      }}
                                      className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-100 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                      <Pencil className="w-3 h-3" />
                                    </button>
                                    <button
                                      onClick={() => handleDeleteOption(step.id, optIdx)}
                                      disabled={step.options.length <= 2}
                                      className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-100 rounded opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-30"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </>
                                )}
                              </div>
                            );
                          })}
                          
                          {/* Add option button */}
                          {step.options.length < 8 && (
                            <button
                              onClick={() => handleAddOption(step.id)}
                              className="w-full flex items-center justify-center gap-1 p-1.5 text-xs text-indigo-600 hover:bg-indigo-50 rounded border border-dashed border-indigo-300"
                            >
                              <Plus className="w-3 h-3" />
                              Add option
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Options display (when not editing) */}
                    {!isEditing && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {step.options.map((option) => {
                          const isMatched = matchedOption?.toLowerCase() === option.label.toLowerCase();
                          return (
                            <div
                              key={option.label}
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                                isMatched
                                  ? 'bg-green-500 text-white font-medium'
                                  : status === 'current'
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              {option.label}
                              <ArrowRight className="w-3 h-3 opacity-50" />
                              <span className="opacity-70">{option.next}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

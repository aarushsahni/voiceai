import { GitBranch, Circle, CheckCircle2, ArrowRight } from 'lucide-react';
import { FlowMap as FlowMapType, FlowStep } from '../types';

interface FlowMapProps {
  flowMap: FlowMapType;
  currentStepId: string | null;
  completedSteps: Set<string>;
  matchedOptions: Map<string, string>; // stepId -> matched option label
}

export function FlowMap({ flowMap, currentStepId, completedSteps, matchedOptions }: FlowMapProps) {
  const getStepStatus = (step: FlowStep) => {
    if (completedSteps.has(step.id)) return 'completed';
    if (step.id === currentStepId) return 'current';
    return 'pending';
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 bg-slate-50">
        <GitBranch className="w-5 h-5 text-indigo-600" />
        <h2 className="font-semibold text-slate-800">{flowMap.title}</h2>
      </div>

      <div className="p-4 space-y-2 max-h-[500px] overflow-y-auto">
        {flowMap.steps.map((step, index) => {
          const status = getStepStatus(step);
          const matchedOption = matchedOptions.get(step.id);

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
                  status === 'current'
                    ? 'border-blue-400 bg-blue-50 shadow-md'
                    : status === 'completed'
                    ? 'border-green-300 bg-green-50'
                    : 'border-slate-200 bg-white'
                }`}
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
                        status === 'current' ? 'text-blue-700' : 
                        status === 'completed' ? 'text-green-700' : 'text-slate-600'
                      }`}>
                        {index + 1}. {step.label}
                      </span>
                      <span className="text-xs text-slate-400">
                        {step.info}
                      </span>
                    </div>

                    {/* Question */}
                    <p className={`text-xs mt-1 ${
                      status === 'current' ? 'text-blue-600' : 'text-slate-500'
                    }`}>
                      "{step.question}"
                    </p>

                    {/* Options */}
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

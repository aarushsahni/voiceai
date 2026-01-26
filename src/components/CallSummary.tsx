import { FileText, Loader2, CheckCircle, XCircle, Phone, PhoneOff, AlertTriangle, MessageSquare, Globe } from 'lucide-react';
import { CallSummaryData } from '../types';

interface CallSummaryProps {
  summary: CallSummaryData | null;
  isLoading: boolean;
}

const outcomeConfig: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  completed: {
    label: 'Completed',
    icon: <CheckCircle className="w-4 h-4" />,
    color: 'bg-green-100 text-green-700 border-green-200',
  },
  incomplete: {
    label: 'Incomplete',
    icon: <AlertTriangle className="w-4 h-4" />,
    color: 'bg-amber-100 text-amber-700 border-amber-200',
  },
  wrong_number: {
    label: 'Wrong Number',
    icon: <PhoneOff className="w-4 h-4" />,
    color: 'bg-red-100 text-red-700 border-red-200',
  },
  no_answer: {
    label: 'No Answer',
    icon: <Phone className="w-4 h-4" />,
    color: 'bg-slate-100 text-slate-700 border-slate-200',
  },
  unknown: {
    label: 'Unknown',
    icon: <Phone className="w-4 h-4" />,
    color: 'bg-slate-100 text-slate-700 border-slate-200',
  },
};

export function CallSummary({ summary, isLoading }: CallSummaryProps) {
  if (!summary && !isLoading) {
    return null;
  }

  if (isLoading) {
    return (
      <div className="bg-slate-50 rounded-lg border border-slate-200 p-4">
        <div className="flex items-center gap-2 mb-3">
          <FileText className="w-5 h-5 text-slate-600" />
          <h3 className="font-semibold text-slate-800">Call Summary</h3>
        </div>
        <div className="flex items-center gap-2 text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Generating summary...</span>
        </div>
      </div>
    );
  }

  if (!summary) return null;

  const outcome = outcomeConfig[summary.outcome] || outcomeConfig.unknown;

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 bg-slate-50">
        <FileText className="w-5 h-5 text-indigo-600" />
        <h3 className="font-semibold text-slate-800">Call Summary</h3>
      </div>

      <div className="p-4 space-y-4">
        {/* Status badges row */}
        <div className="flex flex-wrap gap-2">
          {/* Outcome badge */}
          <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-medium ${outcome.color}`}>
            {outcome.icon}
            {outcome.label}
          </div>

          {/* Callback badge */}
          <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-medium ${
            summary.callbackNeeded 
              ? 'bg-red-100 text-red-700 border-red-200' 
              : 'bg-green-100 text-green-700 border-green-200'
          }`}>
            {summary.callbackNeeded ? (
              <>
                <AlertTriangle className="w-4 h-4" />
                Callback Needed
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4" />
                No Callback
              </>
            )}
          </div>

          {/* Language badge */}
          {summary.language && summary.language !== 'Unknown' && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-medium bg-blue-50 text-blue-700 border-blue-200">
              <Globe className="w-4 h-4" />
              {summary.language}
            </div>
          )}
        </div>

        {/* Patient responses */}
        {summary.patientResponses && summary.patientResponses.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-sm font-medium text-slate-600 mb-2">
              <MessageSquare className="w-4 h-4" />
              Patient Responses
            </div>
            <div className="flex flex-wrap gap-2">
              {summary.patientResponses.map((response, index) => (
                <span
                  key={index}
                  className="inline-block px-3 py-1 bg-indigo-50 text-indigo-700 rounded-lg text-sm border border-indigo-100"
                >
                  {response}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Key findings */}
        {summary.keyFindings && (
          <div>
            <div className="text-sm font-medium text-slate-600 mb-1">Key Findings</div>
            <p className="text-sm text-slate-700 leading-relaxed bg-slate-50 rounded-lg p-3 border border-slate-100">
              {summary.keyFindings}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

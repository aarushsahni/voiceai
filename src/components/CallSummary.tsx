import { FileText, Loader2 } from 'lucide-react';

interface CallSummaryProps {
  summary: string | null;
  isLoading: boolean;
}

export function CallSummary({ summary, isLoading }: CallSummaryProps) {
  if (!summary && !isLoading) {
    return null;
  }

  return (
    <div className="bg-green-50 rounded-lg border border-green-200 p-4">
      <div className="flex items-center gap-2 mb-3">
        <FileText className="w-5 h-5 text-green-600" />
        <h3 className="font-semibold text-green-800">Call Summary</h3>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-green-600">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Generating summary...</span>
        </div>
      ) : (
        <p className="text-sm text-green-800 leading-relaxed">
          {summary}
        </p>
      )}
    </div>
  );
}

import { Zap, Clock } from 'lucide-react';
import { LatencyInfo } from '../types';

interface LatencyTrackerProps {
  latency: LatencyInfo;
}

export function LatencyTracker({ latency }: LatencyTrackerProps) {
  const getLatencyColor = (ms: number | null) => {
    if (ms === null) return 'text-slate-400';
    if (ms < 500) return 'text-green-600';
    if (ms < 1000) return 'text-amber-600';
    return 'text-red-600';
  };

  const formatMs = (ms: number | null) => {
    if (ms === null) return '--';
    return `${Math.round(ms)}`;
  };

  return (
    <div className="bg-amber-50 rounded-lg border border-amber-200 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Zap className="w-5 h-5 text-amber-600" />
        <h3 className="font-semibold text-amber-800">Response Latency</h3>
      </div>

      <div className="grid grid-cols-3 gap-4 text-center">
        <div>
          <div className={`text-2xl font-bold ${getLatencyColor(latency.lastTurnMs)}`}>
            {formatMs(latency.lastTurnMs)}
            <span className="text-sm font-normal ml-1">ms</span>
          </div>
          <div className="text-xs text-amber-700 mt-1">Last Turn</div>
        </div>

        <div>
          <div className={`text-2xl font-bold ${getLatencyColor(latency.avgMs)}`}>
            {formatMs(latency.avgMs)}
            <span className="text-sm font-normal ml-1">ms</span>
          </div>
          <div className="text-xs text-amber-700 mt-1">Average</div>
        </div>

        <div>
          <div className="text-2xl font-bold text-amber-700">
            {latency.turnCount}
          </div>
          <div className="text-xs text-amber-700 mt-1">Turns</div>
        </div>
      </div>

      {latency.lastTurnMs !== null && (
        <div className="mt-3 pt-3 border-t border-amber-200">
          <div className="flex items-center gap-2 text-xs text-amber-700">
            <Clock className="w-3 h-3" />
            <span>
              {latency.lastTurnMs < 500 
                ? 'Excellent response time!' 
                : latency.lastTurnMs < 1000 
                ? 'Good response time' 
                : 'Higher latency detected'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

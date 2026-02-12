import { Phone, PhoneOff, Loader2, AlertTriangle } from 'lucide-react';
import { CallStatus } from '../types';

interface CallControlsProps {
  status: CallStatus;
  onStartCall: () => void;
  onEndCall: () => void;
  isSupported: boolean;
}

export function CallControls({
  status,
  onStartCall,
  onEndCall,
  isSupported,
}: CallControlsProps) {
  const isActive = status !== 'idle' && status !== 'ended' && status !== 'error';
  const isConnecting = status === 'connecting';

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4">
      {!isSupported && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          <AlertTriangle className="w-5 h-5" />
          <span className="text-sm">
            Your browser doesn't support audio recording. Please use Chrome, Firefox, or Edge.
          </span>
        </div>
      )}

      <div className="flex items-center gap-4">
        {/* Call buttons */}
        <div className="flex items-center gap-2">
          {!isActive ? (
            <button
              onClick={onStartCall}
              disabled={!isSupported || isConnecting}
              className="flex items-center gap-2 px-6 py-2.5 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <Phone className="w-5 h-5" />
                  Start Call
                </>
              )}
            </button>
          ) : (
            <button
              onClick={onEndCall}
              className="flex items-center gap-2 px-6 py-2.5 bg-red-600 text-white font-semibold rounded-lg hover:bg-red-700 transition-colors"
            >
              <PhoneOff className="w-5 h-5" />
              End Call
            </button>
          )}
        </div>
      </div>

      {/* Call status indicator */}
      {isActive && (
        <div className="mt-4 flex items-center gap-2 text-sm">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
          </span>
          <span className="text-green-700 font-medium">Call in progress</span>
        </div>
      )}
    </div>
  );
}

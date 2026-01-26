import { Mic, Volume2, Loader2, CheckCircle, AlertCircle, Phone, PhoneOff } from 'lucide-react';
import { CallStatus } from '../types';

interface StatusIndicatorProps {
  status: CallStatus;
}

const statusConfig: Record<CallStatus, { 
  icon: React.ReactNode; 
  text: string; 
  bgColor: string; 
  textColor: string;
  animate?: boolean;
}> = {
  idle: {
    icon: <Phone className="w-5 h-5" />,
    text: 'Ready to start call',
    bgColor: 'bg-slate-100',
    textColor: 'text-slate-600',
  },
  connecting: {
    icon: <Loader2 className="w-5 h-5 animate-spin" />,
    text: 'Connecting...',
    bgColor: 'bg-amber-100',
    textColor: 'text-amber-700',
  },
  connected: {
    icon: <Phone className="w-5 h-5" />,
    text: 'Connected',
    bgColor: 'bg-green-100',
    textColor: 'text-green-700',
  },
  listening: {
    icon: <Mic className="w-5 h-5" />,
    text: 'Listening to patient...',
    bgColor: 'bg-teal-100',
    textColor: 'text-teal-700',
    animate: true,
  },
  assistant_speaking: {
    icon: <Volume2 className="w-5 h-5" />,
    text: 'Assistant Speaking',
    bgColor: 'bg-blue-100',
    textColor: 'text-blue-700',
    animate: true,
  },
  user_speaking: {
    icon: <Mic className="w-5 h-5" />,
    text: 'User Speaking',
    bgColor: 'bg-emerald-100',
    textColor: 'text-emerald-700',
    animate: true,
  },
  processing: {
    icon: <Loader2 className="w-5 h-5 animate-spin" />,
    text: 'Processing...',
    bgColor: 'bg-purple-100',
    textColor: 'text-purple-700',
  },
  ended: {
    icon: <CheckCircle className="w-5 h-5" />,
    text: 'Call Ended',
    bgColor: 'bg-slate-100',
    textColor: 'text-slate-600',
  },
  error: {
    icon: <AlertCircle className="w-5 h-5" />,
    text: 'Error',
    bgColor: 'bg-red-100',
    textColor: 'text-red-700',
  },
};

export function StatusIndicator({ status }: StatusIndicatorProps) {
  const config = statusConfig[status];

  return (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-lg ${config.bgColor}`}>
      <div className={`relative ${config.textColor}`}>
        {config.icon}
        {config.animate && (
          <span className={`absolute inset-0 rounded-full ${config.bgColor} animate-pulse-ring`} />
        )}
      </div>
      <div>
        <div className={`font-semibold ${config.textColor}`}>
          {config.text}
        </div>
        {(status === 'assistant_speaking' || status === 'user_speaking' || status === 'listening') && (
          <div className={`audio-wave mt-1 ${config.textColor}`}>
            <span></span>
            <span></span>
            <span></span>
            <span></span>
            <span></span>
          </div>
        )}
      </div>
    </div>
  );
}

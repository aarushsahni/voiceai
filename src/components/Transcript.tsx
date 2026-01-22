import { useRef, useEffect } from 'react';
import { MessageSquare, User, Bot, Info } from 'lucide-react';
import { TranscriptEntry } from '../types';

interface TranscriptProps {
  entries: TranscriptEntry[];
}

export function Transcript({ entries }: TranscriptProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const getIcon = (role: string) => {
    switch (role) {
      case 'user':
        return <User className="w-4 h-4" />;
      case 'assistant':
        return <Bot className="w-4 h-4" />;
      default:
        return <Info className="w-4 h-4" />;
    }
  };

  const getStyles = (role: string) => {
    switch (role) {
      case 'user':
        return {
          container: 'bg-emerald-50 border-emerald-200',
          label: 'text-emerald-700',
          icon: 'text-emerald-600',
        };
      case 'assistant':
        return {
          container: 'bg-blue-50 border-blue-200',
          label: 'text-blue-700',
          icon: 'text-blue-600',
        };
      default:
        return {
          container: 'bg-amber-50 border-amber-200',
          label: 'text-amber-700',
          icon: 'text-amber-600',
        };
    }
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 bg-slate-50">
        <MessageSquare className="w-5 h-5 text-blue-600" />
        <h2 className="font-semibold text-slate-800">Live Transcript</h2>
        <span className="ml-auto text-sm text-slate-500">
          {entries.length} message{entries.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[300px] max-h-[500px]">
        {entries.length === 0 ? (
          <div className="text-center text-slate-400 py-8">
            <MessageSquare className="w-12 h-12 mx-auto mb-2 opacity-50" />
            <p>Transcript will appear here once the call starts</p>
          </div>
        ) : (
          entries.map((entry) => {
            const styles = getStyles(entry.role);
            return (
              <div
                key={entry.id}
                className={`p-3 rounded-lg border ${styles.container}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={styles.icon}>{getIcon(entry.role)}</span>
                  <span className={`font-semibold text-sm ${styles.label}`}>
                    {entry.role.charAt(0).toUpperCase() + entry.role.slice(1)}
                  </span>
                  <span className="text-xs text-slate-400 ml-auto">
                    {formatTime(entry.timestamp)}
                  </span>
                </div>
                <p className="text-slate-700 text-sm leading-relaxed">
                  {entry.text}
                </p>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

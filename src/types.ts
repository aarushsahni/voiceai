export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: Date;
}

export interface FlowStep {
  id: string;
  label: string;
  info: string;
  question: string;
  options: FlowOption[];
}

export interface FlowOption {
  label: string;
  next: string;
}

export interface FlowMap {
  title: string;
  steps: FlowStep[];
}

export interface SessionInfo {
  clientSecret: string;
  expiresAt: number;
}

export type CallStatus = 
  | 'idle' 
  | 'connecting' 
  | 'connected' 
  | 'assistant_speaking' 
  | 'user_speaking' 
  | 'processing' 
  | 'ended'
  | 'error';

export interface LatencyInfo {
  lastTurnMs: number | null;
  avgMs: number | null;
  turnCount: number;
}

export interface ScriptConfig {
  id: string;
  name: string;
  systemPrompt: string;
  voice: string;
}

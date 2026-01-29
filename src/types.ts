export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: Date;
}

export interface FlowStep {
  id: string;
  label: string;
  type?: 'question' | 'statement';  // question = wait for response (default), statement = auto-continue
  info: string;
  question: string;
  options: FlowOption[];
}

export interface FlowOption {
  label: string;
  keywords?: string[];  // voice5.py includes keywords for matching
  next: string;
  triggers_callback?: boolean;  // If true, this option triggers a callback request
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
  | 'listening'  // Mic is active, waiting for patient to speak
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

export interface CallSummaryData {
  outcome: 'completed' | 'incomplete' | 'wrong_number' | 'no_answer' | 'unknown';
  callbackNeeded: boolean;
  patientResponses: string[];
  keyFindings: string;
  language: string;
}

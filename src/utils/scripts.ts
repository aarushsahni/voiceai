import { FlowMap, ScriptConfig } from '../types';

// Default IVR flow map for visualization
export const defaultFlowMap: FlowMap = {
  title: 'ED Follow-up Call',
  steps: [
    {
      id: 'language',
      label: 'Language Selection',
      info: 'English or Español',
      question: "To continue in English, please say 'English'. Para continuar en español, diga 'Español'.",
      options: [
        { label: 'English', next: 'confirm' },
        { label: 'Español', next: 'confirm' },
      ],
    },
    {
      id: 'confirm',
      label: 'Identity Confirmation',
      info: 'Confirm recent ER departure',
      question: 'Our records show you recently left the emergency department. Is that correct?',
      options: [
        { label: 'Yes', next: 'general_status' },
        { label: 'No', next: 'END (wrong number)' },
      ],
    },
    {
      id: 'general_status',
      label: 'General Status',
      info: 'How are they feeling',
      question: "How are you feeling since leaving the ER? Say 'As expected' or 'Have a concern'.",
      options: [
        { label: 'As expected', next: 'reason' },
        { label: 'Have a concern', next: 'reason (+ callback)' },
      ],
    },
    {
      id: 'reason',
      label: 'Reason for Leaving',
      info: 'Why left before visit complete',
      question: 'Why did you leave the ER before your visit was finished?',
      options: [
        { label: 'Wait was too long', next: 'disposition' },
        { label: 'I felt better', next: 'disposition' },
        { label: 'I felt worse', next: 'disposition' },
      ],
    },
    {
      id: 'disposition',
      label: 'Disposition',
      info: 'Where they went after leaving',
      question: "Where did you go after leaving? Say 'Went home', 'Went to another ER', or 'Went somewhere else'.",
      options: [
        { label: 'Went home', next: 'END (disclaimer)' },
        { label: 'Went to another ER', next: 'END (disclaimer)' },
        { label: 'Went somewhere else', next: 'END (disclaimer)' },
      ],
    },
  ],
};

// Available script configurations
export const scriptConfigs: ScriptConfig[] = [
  {
    id: 'ed-followup-v1',
    name: 'ED Follow-up (Standard)',
    voice: 'alloy',
    systemPrompt: '', // Uses default from API
  },
  {
    id: 'ed-followup-short',
    name: 'ED Follow-up (Short)',
    voice: 'alloy',
    systemPrompt: `Penn Medicine LGH ED follow-up call (short version). Be warm and conversational.

START: "Hello, this is Penn Medicine calling about your recent ER visit. To continue in English, say 'English'. Para español, diga 'Español'."

ENGLISH FLOW:
1. English → "Thanks for answering. Our records show you left before your visit was complete. Is that correct?"
2. Yes → "How are you feeling? Say 'As expected' or 'Have a concern'."
   No → "Sorry to bother you. Goodbye." [END]
3. Answer status → "Why did you leave? Say 'Wait too long', 'Felt better', or 'Felt worse'."
4. Answer reason → "Where did you go after? Say 'Home', 'Another ER', or 'Somewhere else'."
5. Answer → "Thank you. If you have health concerns, contact your doctor. Take care, goodbye!" [END]

Accept natural variations. Keep responses brief.`,
  },
];

// Final phrases that indicate call should end
export const finalPhrases = [
  'goodbye',
  'bye',
  'take care',
  'adiós',
  'adios',
  'cuídese',
  'cuidese',
];

// Check if text contains a final phrase
export function containsFinalPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return finalPhrases.some(phrase => lower.includes(phrase));
}

// Try to match user response to flow step options
export function matchUserResponse(
  userText: string,
  stepId: string,
  flowMap: FlowMap
): string | null {
  const step = flowMap.steps.find(s => s.id === stepId);
  if (!step) return null;

  const lower = userText.toLowerCase();
  
  // Common variations mapping
  const variations: Record<string, string[]> = {
    'english': ['english', 'inglés', 'ingles'],
    'español': ['español', 'spanish', 'espanol'],
    'yes': ['yes', 'yeah', 'yep', 'correct', "that's right", 'si', 'sí'],
    'no': ['no', 'nope', 'incorrect', 'wrong'],
    'as expected': ['as expected', 'expected', 'fine', 'good', 'okay', 'ok', 'como esperaba'],
    'have a concern': ['concern', 'worried', 'not good', 'preocupación', 'preocupacion'],
    'wait was too long': ['wait', 'waiting', 'too long', 'espera', 'larga'],
    'i felt better': ['better', 'felt better', 'mejor'],
    'i felt worse': ['worse', 'felt worse', 'peor'],
    'went home': ['home', 'went home', 'casa'],
    'went to another er': ['another er', 'other er', 'different er', 'otra sala'],
    'went somewhere else': ['somewhere else', 'other', 'else', 'otro lugar'],
  };

  for (const option of step.options) {
    const optionLower = option.label.toLowerCase();
    
    // Direct match
    if (lower.includes(optionLower)) {
      return option.label;
    }
    
    // Check variations
    const optionVariations = variations[optionLower];
    if (optionVariations && optionVariations.some(v => lower.includes(v))) {
      return option.label;
    }
  }

  return null;
}

// Infer current flow step from conversation
export function inferFlowStep(
  transcripts: { role: string; text: string }[],
  flowMap: FlowMap
): string | null {
  // Look at the last assistant message to determine current step
  const lastAssistant = [...transcripts]
    .reverse()
    .find(t => t.role === 'assistant');
  
  if (!lastAssistant) return flowMap.steps[0]?.id || null;

  const text = lastAssistant.text.toLowerCase();

  // Check each step's question for a match
  for (const step of flowMap.steps) {
    const questionWords = step.question.toLowerCase().split(' ').slice(0, 5);
    const matches = questionWords.filter(w => w.length > 3 && text.includes(w));
    if (matches.length >= 2) {
      return step.id;
    }
  }

  // Fallback: check for keywords
  if (text.includes('english') || text.includes('español')) return 'language';
  if (text.includes('correct') || text.includes('records show')) return 'confirm';
  if (text.includes('feeling') || text.includes('concern')) return 'general_status';
  if (text.includes('why did you leave')) return 'reason';
  if (text.includes('where did you go')) return 'disposition';

  return null;
}

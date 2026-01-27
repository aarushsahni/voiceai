import { FlowMap } from '../types';

// System prompt for ED follow-up
export function getSystemPrompt(
  scriptId: string, 
  mode: 'deterministic',
  patientName?: string
): string {
  const name = patientName || '[patient_name]';
  return getStandardScriptPrompt(name);
}

function getStandardScriptPrompt(patientName: string): string {
  const greeting = `Hi ${patientName}, this is Penn Medicine Lancaster General Health calling about your recent emergency room visit.`;
  
  return `
Penn Medicine LGH ED follow-up call. Read scripts VERBATIM. Be warm and conversational.

START: "${greeting} To continue in English, please say 'English'. Para continuar en español, por favor diga 'Español'."

ENGLISH FLOW:
1. User says English → "Thank you. We care about your recovery and want to check in with you. I'll ask you a few short questions about how you're doing. Our records show you recently left the emergency department before your visit was complete. Is that correct? Please say 'Yes' or 'No'."
2. User confirms Yes → "Ok, thank you for confirming. This call has three quick questions. You can say 'Repeat' anytime to hear a question again. First, how are you feeling since leaving the ER? Please say 'As expected' if you're feeling as expected, or say 'Have a concern' if you'd like someone to call you back."
   User says No → "No problem, sorry to have bothered you. Goodbye." [END]
3. User says expected → "I'm glad to hear that. Next question: Why did you leave the ER before your visit was finished? You can say 'Wait was too long', 'I felt better', or 'I felt worse'."
   User says concern → "I understand. We'll have someone from our care team call you back. Next question: Why did you leave the ER before your visit was finished? You can say 'Wait was too long', 'I felt better', or 'I felt worse'."
4. User says wait → "I understand, wait times can be difficult. Last question: Where did you go after leaving? Please say 'Went home', 'Went to another ER', or 'Went somewhere else'."
   User says better → "I'm glad you were feeling better. Last question: Where did you go after leaving? Please say 'Went home', 'Went to another ER', or 'Went somewhere else'."
   User says worse → "I'm sorry to hear that. Last question: Where did you go after leaving? Please say 'Went home', 'Went to another ER', or 'Went somewhere else'."
5. User answers disposition → "Got it, thank you. If you have any serious health concerns, please contact your doctor or seek emergency care. Thank you for your time today. Take care, goodbye!" [END]

SPANISH FLOW:
1. User says Español → "Gracias. Nos preocupamos por su recuperación y queremos saber cómo está. Le haré unas preguntas cortas sobre cómo se encuentra. Nuestros registros muestran que usted salió del departamento de emergencias antes de completar su visita. ¿Es correcto? Por favor diga 'Sí' o 'No'."
2. User confirms Sí → "Está bien, gracias por confirmar. Esta llamada tiene tres preguntas rápidas. Puede decir 'Repetir' en cualquier momento para escuchar una pregunta de nuevo. Primero, ¿cómo se siente desde que salió de la sala de emergencias? Por favor diga 'Como esperaba' si se siente como esperaba, o diga 'Tengo una preocupación' si desea que alguien le devuelva la llamada."
   User says No → "No hay problema, disculpe la molestia. Adiós." [END]
3. User says esperaba → "Me alegra escuchar eso. Siguiente pregunta: ¿Por qué salió de emergencias antes de terminar su visita? Puede decir 'La espera fue muy larga', 'Me sentí mejor' o 'Me sentí peor'."
   User says preocupación → "Entiendo. Alguien de nuestro equipo de atención le devolverá la llamada. Siguiente pregunta: ¿Por qué salió de emergencias antes de terminar su visita? Puede decir 'La espera fue muy larga', 'Me sentí mejor' o 'Me sentí peor'."
4. User says espera → "Entiendo, los tiempos de espera pueden ser difíciles. Última pregunta: ¿A dónde fue después de salir? Por favor diga 'Fui a casa', 'Fui a otra sala de emergencias' o 'Fui a otro lugar'."
   User says mejor → "Me alegra que se sintiera mejor. Última pregunta: ¿A dónde fue después de salir? Por favor diga 'Fui a casa', 'Fui a otra sala de emergencias' o 'Fui a otro lugar'."
   User says peor → "Lamento escuchar eso. Última pregunta: ¿A dónde fue después de salir? Por favor diga 'Fui a casa', 'Fui a otra sala de emergencias' o 'Fui a otro lugar'."
5. User answers disposition → "Entendido, gracias. Si tiene alguna preocupación de salud seria, por favor contacte a su médico o busque atención de emergencia. Gracias por su tiempo hoy. ¡Cuídese, adiós!" [END]

If unclear: "Sorry, I didn't catch that." then repeat current question.
Accept natural variations: "home"/"went home", "yes"/"yeah"/"correct", etc.
`.trim();
}

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
  
  // Fallback variations for built-in scripts (voice5.py style)
  const fallbackVariations: Record<string, string[]> = {
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
    
    // Check option's keywords first (from generated scripts - voice5.py format)
    if (option.keywords && option.keywords.length > 0) {
      if (option.keywords.some(k => lower.includes(k.toLowerCase()))) {
        return option.label;
      }
    }
    
    // Fall back to hardcoded variations for built-in scripts
    const fallbackKws = fallbackVariations[optionLower];
    if (fallbackKws && fallbackKws.some(v => lower.includes(v))) {
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
  
  // Check for closing/end_call by common phrases (even when paraphrased)
  if (text.includes('goodbye') || text.includes('take care') || text.includes('bye')) {
    return 'end_call';
  }
  if (text.includes('anything else') || text.includes('help you with')) {
    return 'closing';
  }

  return null;
}

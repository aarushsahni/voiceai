/**
 * Matcher test cases — exercises /api/match (the per-turn LLM option matcher).
 * Each case feeds a question + options + what the patient said, and asserts which
 * option index should be picked (or null for no-match).
 *
 * These mirror the real failure modes: phonetic transcription errors, negations,
 * Spanish, colloquial variations, and genuinely ambiguous answers.
 */

export interface MatcherCase {
  name: string;
  question: string;
  options: { label: string; next: string; triggers_callback?: boolean }[];
  userResponse: string;
  transcriptSoFar?: string;
  /** Expected option label, or null if we expect no confident match. */
  expect: string | null;
}

const yesNo = [
  { label: 'Yes', next: 'general_status' },
  { label: 'No', next: 'end_call' },
];

const status = [
  { label: 'As expected', next: 'reason' },
  { label: 'Have a concern', next: 'reason', triggers_callback: true },
];

const reason = [
  { label: 'Wait was too long', next: 'disposition' },
  { label: 'I felt better', next: 'disposition' },
  { label: 'I felt worse', next: 'disposition' },
];

const disposition = [
  { label: 'Went home', next: 'end_call' },
  { label: 'Went to another ER', next: 'end_call' },
  { label: 'Went somewhere else', next: 'end_call' },
];

const language = [
  { label: 'English', next: 'confirm' },
  { label: 'Español', next: 'confirm' },
];

export const matcherCases: MatcherCase[] = [
  // --- Yes/No confirmation ---
  { name: 'plain yes', question: 'Is that correct?', options: yesNo, userResponse: 'Yes', expect: 'Yes' },
  { name: 'colloquial yeah', question: 'Is that correct?', options: yesNo, userResponse: "Yeah that's right", expect: 'Yes' },
  { name: 'plain no', question: 'Is that correct?', options: yesNo, userResponse: 'No', expect: 'No' },
  { name: 'negation nope', question: 'Is that correct?', options: yesNo, userResponse: 'Nope, wrong person', expect: 'No' },
  { name: 'correct = yes', question: 'Is that correct?', options: yesNo, userResponse: 'correct', expect: 'Yes' },

  // --- General status ---
  { name: 'as expected plain', question: 'How are you feeling?', options: status, userResponse: 'as expected', expect: 'As expected' },
  { name: 'feeling fine', question: 'How are you feeling?', options: status, userResponse: "I'm feeling fine, pretty normal", expect: 'As expected' },
  { name: 'concern triggers callback', question: 'How are you feeling?', options: status, userResponse: "Actually I'm worried, I'd like someone to call me", expect: 'Have a concern' },
  { name: 'phonetic: is expected', question: 'How are you feeling?', options: status, userResponse: 'is expected', expect: 'As expected' },

  // --- Reason for leaving ---
  { name: 'wait too long', question: 'Why did you leave?', options: reason, userResponse: 'the wait was way too long', expect: 'Wait was too long' },
  { name: 'felt better', question: 'Why did you leave?', options: reason, userResponse: 'I started feeling better so I left', expect: 'I felt better' },
  { name: 'felt worse', question: 'Why did you leave?', options: reason, userResponse: 'honestly I felt worse sitting there', expect: 'I felt worse' },
  { name: 'better vs worse negation', question: 'Why did you leave?', options: reason, userResponse: "I didn't feel better, I felt worse", expect: 'I felt worse' },

  // --- Disposition ---
  { name: 'went home', question: 'Where did you go?', options: disposition, userResponse: 'I just went home', expect: 'Went home' },
  { name: 'another ER', question: 'Where did you go?', options: disposition, userResponse: 'I went to a different emergency room', expect: 'Went to another ER' },
  { name: 'somewhere else', question: 'Where did you go?', options: disposition, userResponse: 'I went to my friends place', expect: 'Went somewhere else' },

  // --- Language ---
  { name: 'english', question: 'English or Spanish?', options: language, userResponse: 'English please', expect: 'English' },
  { name: 'spanish word', question: 'English or Spanish?', options: language, userResponse: 'Español', expect: 'Español' },
  { name: 'spanish in english', question: 'English or Spanish?', options: language, userResponse: 'Spanish', expect: 'Español' },

  // --- Spanish responses ---
  { name: 'spanish sí', question: '¿Es correcto?', options: yesNo, userResponse: 'Sí, correcto', expect: 'Yes' },
  { name: 'spanish como esperaba', question: '¿Cómo se siente?', options: status, userResponse: 'como esperaba', expect: 'As expected' },
  { name: 'spanish casa', question: '¿A dónde fue?', options: disposition, userResponse: 'fui a casa', expect: 'Went home' },

  // --- Ambiguous / no confident match (these are allowed to be null) ---
  { name: 'irrelevant chatter', question: 'Why did you leave?', options: reason, userResponse: "what's the weather like", expect: null },
];

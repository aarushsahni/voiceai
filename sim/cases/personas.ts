/**
 * Patient personas for the conversation simulator. Each persona is played by an LLM
 * that responds turn-by-turn to the IVR agent. After the call we assert that the
 * expected flow steps were visited and the expected outcome was reached.
 */

export interface Persona {
  name: string;
  /** Instructions describing how this simulated patient behaves. */
  description: string;
  language: 'English' | 'Spanish';
  /** Flow step ids we expect to be visited during the call. */
  expectedSteps: string[];
  /** Whether this call should flag a clinical callback. */
  expectCallback: boolean;
  /** Whether the call should reach a goodbye/end. */
  expectGoodbye: boolean;
}

export const personas: Persona[] = [
  {
    name: 'cooperative-english-home',
    description:
      'You are a calm, cooperative patient. You speak English. You confirm you left the ER early. ' +
      'You feel as expected (fine). You left because the wait was too long. You went home afterward. ' +
      'Answer briefly and naturally, one short sentence per turn.',
    language: 'English',
    expectedSteps: ['language', 'confirm', 'general_status', 'reason', 'disposition'],
    expectCallback: false,
    expectGoodbye: true,
  },
  {
    name: 'concerned-english-callback',
    description:
      'You are an English-speaking patient who is worried about how you feel. You confirm you left the ER. ' +
      'When asked how you are feeling, you say you have a concern and would like someone to call you back. ' +
      'You left because you felt worse. You went to another ER. Keep answers short and natural.',
    language: 'English',
    expectedSteps: ['language', 'confirm', 'general_status', 'reason', 'disposition'],
    expectCallback: true,
    expectGoodbye: true,
  },
  {
    name: 'wrong-number-english',
    description:
      'You are an English speaker. When asked to confirm you recently left the emergency department, you say ' +
      'No — that is not you, you were never at the ER. You are polite but clear it is the wrong person.',
    language: 'English',
    expectedSteps: ['language', 'confirm'],
    expectCallback: false,
    expectGoodbye: true,
  },
  {
    name: 'spanish-cooperative',
    description:
      'Eres un paciente que habla español. Responde SIEMPRE en español, en frases cortas y naturales. ' +
      'Cuando pregunten el idioma, di "Español". Confirmas que saliste de emergencias. Te sientes como esperabas. ' +
      'Saliste porque la espera fue muy larga. Fuiste a casa después.',
    language: 'Spanish',
    expectedSteps: ['language', 'confirm', 'general_status', 'reason', 'disposition'],
    expectCallback: false,
    expectGoodbye: true,
  },
  {
    name: 'terse-mumbler-english',
    description:
      'You are an English speaker who gives very terse, mumbled, colloquial answers (e.g. "yeah", "nah", ' +
      '"meh fine", "too long", "home"). You confirm you left, you feel fine, you left because the wait was too long, ' +
      'and you went home. Never give long answers.',
    language: 'English',
    expectedSteps: ['language', 'confirm', 'general_status', 'reason', 'disposition'],
    expectCallback: false,
    expectGoodbye: true,
  },
];

import { requireApiKey } from './lib/env';
import { invokeHandler } from './lib/invokeHandler';
import generateHandler from '../api/generate';
import summaryHandler from '../api/summary';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

// Natural-language description → uses the `prompt` generation path.
// (The `script` path expects SurveyJS-style JSON with pages/elements, not freeform text.)
const SAMPLE_PROMPT = `Create a follow-up call for patients who missed their appointment.
Greet them by name ([patient_name]) and offer English or Spanish.
Confirm they meant to miss the appointment, ask if they want to reschedule,
and ask if they have any concerns — if they do, the care team should call them back.
End politely with a goodbye.`;

const SAMPLE_TRANSCRIPT = [
  { role: 'assistant', text: 'Hi Maria, this is Penn Medicine. To continue in English, say English.' },
  { role: 'user', text: 'English' },
  { role: 'assistant', text: 'Our records show you recently left the emergency department. Is that correct?' },
  { role: 'user', text: 'Yes that is right' },
  { role: 'assistant', text: 'How are you feeling? Say as expected or have a concern.' },
  { role: 'user', text: "I'm worried, please have someone call me back" },
  { role: 'assistant', text: 'I understand, someone from our care team will call you back. Where did you go after leaving?' },
  { role: 'user', text: 'I went home' },
  { role: 'assistant', text: 'Got it. Take care, goodbye!' },
];

function validateFlowMap(flow: any): Check[] {
  const checks: Check[] = [];
  const steps: any[] = Array.isArray(flow?.steps) ? flow.steps : [];

  checks.push({ name: 'flow has steps', ok: steps.length > 0, detail: `${steps.length} steps` });

  const ids = new Set(steps.map((s) => s.id));
  const isEnd = (next: string) => /^(end_call|end)\b/i.test(next) || /\bend\b/i.test(next);

  let danglingRefs = 0;
  for (const step of steps) {
    for (const opt of step.options || []) {
      if (!opt.next) continue;
      if (!ids.has(opt.next) && !isEnd(opt.next)) danglingRefs++;
    }
  }
  checks.push({
    name: 'no dangling next references',
    ok: danglingRefs === 0,
    detail: danglingRefs === 0 ? 'all next refs valid' : `${danglingRefs} dangling`,
  });

  const hasEndPath = steps.some((s) => (s.options || []).some((o: any) => o.next && isEnd(o.next)));
  checks.push({ name: 'has an end/closing path', ok: hasEndPath });

  return checks;
}

export async function runFlowChecks(): Promise<{ passed: number; total: number }> {
  requireApiKey();
  console.log('\n🧭 Flow + summary checks\n');

  const checks: Check[] = [];

  // --- generate ---
  try {
    console.log('  ▶ /api/generate (open-ended prompt) ...');
    const { status, body } = await invokeHandler(generateHandler, {
      script: SAMPLE_PROMPT,
      inputType: 'prompt',
    });
    checks.push({ name: 'generate returns 200', ok: status === 200, detail: `HTTP ${status}` });
    checks.push({ name: 'generate returns greeting', ok: Boolean(body?.greeting) });
    checks.push({ name: 'generate returns scriptContent', ok: Boolean(body?.scriptContent) });
    if (body?.flowMap) checks.push(...validateFlowMap(body.flowMap));
    else checks.push({ name: 'generate returns flowMap', ok: false });
  } catch (err) {
    checks.push({ name: 'generate call', ok: false, detail: String(err) });
  }

  // --- summary ---
  try {
    console.log('  ▶ /api/summary ...');
    const { status, body } = await invokeHandler(summaryHandler, {
      timeline: SAMPLE_TRANSCRIPT,
      needsCallback: true,
      callbackReasons: ['Patient requested callback'],
    });
    const summary = body?.summary;
    checks.push({ name: 'summary returns 200', ok: status === 200, detail: `HTTP ${status}` });
    checks.push({ name: 'summary has outcome', ok: Boolean(summary?.outcome) });
    checks.push({ name: 'summary detects callback', ok: summary?.callbackNeeded === true });
    checks.push({
      name: 'summary detects English',
      ok: summary?.language === 'English',
      detail: `language=${summary?.language}`,
    });
  } catch (err) {
    checks.push({ name: 'summary call', ok: false, detail: String(err) });
  }

  let passed = 0;
  for (const c of checks) {
    if (c.ok) passed++;
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  }
  console.log(`\n  ${passed}/${checks.length} checks passed\n`);
  return { passed, total: checks.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFlowChecks().then((r) => process.exit(r.passed === r.total ? 0 : 1));
}

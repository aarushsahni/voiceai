import { requireApiKey } from './lib/env';
import { chat, ChatMessage } from './lib/chat';
import { invokeHandler } from './lib/invokeHandler';
import { personas, Persona } from './cases/personas';
import matchHandler from '../api/match';
import summaryHandler from '../api/summary';
import {
  getSystemPrompt,
  defaultFlowMap,
  inferFlowStep,
  containsFinalPhrase,
} from '../src/utils/scripts';
import type { FlowMap } from '../src/types';

const IVR_MODEL = process.env.IVR_MODEL || 'gpt-4o';
const PATIENT_MODEL = process.env.PATIENT_MODEL || 'gpt-4o-mini';
const SAMPLE_NAME = 'Maria';
const MAX_TURNS = 16;

interface TraceTurn {
  role: 'assistant' | 'user';
  text: string;
  stepId?: string | null;
  matchedOption?: string | null;
}

export interface ConversationResult {
  persona: string;
  visitedSteps: string[];
  reachedGoodbye: boolean;
  callbackFlagged: boolean;
  trace: TraceTurn[];
  passed: boolean;
  failures: string[];
}

function buildIvrPrompt(): string {
  return getSystemPrompt('ed-followup-v1').replace(/\[patient_name\]/gi, SAMPLE_NAME);
}

/** Ask the patient persona for its next spoken line, given the transcript so far. */
async function patientReply(
  apiKey: string,
  persona: Persona,
  transcript: TraceTurn[],
): Promise<string> {
  const convo = transcript
    .map((t) => `${t.role === 'assistant' ? 'Agent' : 'You'}: ${t.text}`)
    .join('\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `You are role-playing a patient receiving an automated phone call from a hospital. ` +
        `Persona:\n${persona.description}\n\n` +
        `Rules:\n` +
        `- Reply with ONLY what you say out loud — no narration, no quotes.\n` +
        `- Keep it short and natural, like real speech on a phone.\n` +
        `- Stay in character and answer the agent's most recent question.\n` +
        `- If the agent has clearly said goodbye / ended the call, reply with exactly: <END>`,
    },
    {
      role: 'user',
      content: `Call so far:\n${convo}\n\nYour next line:`,
    },
  ];

  const reply = await chat(apiKey, messages, { model: PATIENT_MODEL, temperature: 0.7, maxTokens: 80 });
  return reply.replace(/^["']|["']$/g, '').trim();
}

/** Ask the IVR agent for its next line given the running message history. */
async function ivrReply(apiKey: string, messages: ChatMessage[]): Promise<string> {
  return chat(apiKey, messages, { model: IVR_MODEL, temperature: 0.4, maxTokens: 300 });
}

async function matchOption(
  question: string,
  userResponse: string,
  options: FlowMap['steps'][number]['options'],
  transcriptSoFar: string,
): Promise<string | null> {
  if (!options?.length) return null;
  const { body } = await invokeHandler(matchHandler, { question, userResponse, options, transcriptSoFar });
  return body?.match ?? null;
}

export async function runPersona(apiKey: string, persona: Persona): Promise<ConversationResult> {
  const flowMap = defaultFlowMap;
  const ivrPrompt = buildIvrPrompt();

  const messages: ChatMessage[] = [
    { role: 'system', content: ivrPrompt },
    { role: 'user', content: 'Start the call now with your greeting and first question.' },
  ];

  const trace: TraceTurn[] = [];
  const visitedSteps = new Set<string>();
  let callbackFlagged = false;
  let reachedGoodbye = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // 1. IVR speaks
    const agentText = await ivrReply(apiKey, messages);
    messages.push({ role: 'assistant', content: agentText });

    // Determine current step from the assistant's line
    const stepId = inferFlowStep(
      trace.concat({ role: 'assistant', text: agentText }).map((t) => ({ role: t.role, text: t.text })),
      flowMap,
    );
    if (stepId) visitedSteps.add(stepId);
    trace.push({ role: 'assistant', text: agentText, stepId });

    if (containsFinalPhrase(agentText)) {
      reachedGoodbye = true;
      break;
    }

    // 2. Patient responds
    const userText = await patientReply(apiKey, persona, trace);
    if (userText.includes('<END>') || userText === '') {
      reachedGoodbye = reachedGoodbye || containsFinalPhrase(agentText);
      break;
    }
    messages.push({ role: 'user', content: userText });

    // Match the patient's answer against the current step's options (for the trace + callback flag)
    let matchedOption: string | null = null;
    if (stepId) {
      const step = flowMap.steps.find((s) => s.id === stepId);
      if (step && step.options.length > 1) {
        const transcriptSoFar = trace
          .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`)
          .join('\n');
        matchedOption = await matchOption(step.question, userText, step.options, transcriptSoFar);
        const opt = step.options.find((o) => o.label === matchedOption);
        if (opt?.triggers_callback) callbackFlagged = true;
      }
    }
    trace.push({ role: 'user', text: userText, stepId, matchedOption });
  }

  // Mirror App.tsx: when the call ends, run the post-call summary, which can also
  // surface callbacks (summary.callbackNeeded / callbackActions) for built-in scripts
  // whose flow map doesn't carry per-option triggers_callback flags.
  let summaryCallback = false;
  try {
    const timeline = trace.map((t) => ({ role: t.role, text: t.text }));
    const { body } = await invokeHandler(summaryHandler, {
      timeline,
      needsCallback: callbackFlagged,
      callbackReasons: callbackFlagged ? ['Patient selected a callback option'] : [],
    });
    const summary = body?.summary;
    summaryCallback =
      summary?.callbackNeeded === true || (summary?.callbackActions?.length ?? 0) > 0;
  } catch {
    /* summary is best-effort */
  }
  const callbackDetected = callbackFlagged || summaryCallback;

  // --- Assertions ---
  const failures: string[] = [];
  for (const expected of persona.expectedSteps) {
    if (!visitedSteps.has(expected)) failures.push(`did not visit step "${expected}"`);
  }
  if (persona.expectGoodbye && !reachedGoodbye) failures.push('call never reached goodbye/end');
  if (persona.expectCallback && !callbackDetected) failures.push('expected callback was NOT flagged');
  if (!persona.expectCallback && callbackDetected) failures.push('unexpected callback flagged');

  return {
    persona: persona.name,
    visitedSteps: [...visitedSteps],
    reachedGoodbye,
    callbackFlagged: callbackDetected,
    trace,
    passed: failures.length === 0,
    failures,
  };
}

export async function runConversationSuite(opts: { verbose?: boolean } = {}): Promise<ConversationResult[]> {
  const apiKey = requireApiKey();
  console.log(`\n💬 Conversation suite — ${personas.length} personas (IVR=${IVR_MODEL}, patient=${PATIENT_MODEL})\n`);

  const results: ConversationResult[] = [];
  // Run personas sequentially to keep logs readable and avoid rate limits.
  for (const persona of personas) {
    process.stdout.write(`  ▶ ${persona.name} ... `);
    try {
      const result = await runPersona(apiKey, persona);
      results.push(result);
      console.log(result.passed ? '✅ pass' : `❌ fail (${result.failures.join('; ')})`);
      if (opts.verbose || !result.passed) {
        for (const t of result.trace) {
          const tag = t.role === 'assistant' ? 'AGENT' : 'PATIENT';
          const meta = t.stepId ? ` [${t.stepId}${t.matchedOption ? ` → ${t.matchedOption}` : ''}]` : '';
          console.log(`      ${tag}: ${t.text}${meta}`);
        }
        console.log(`      visited: ${result.visitedSteps.join(', ') || '(none)'}\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`💥 ERROR: ${msg}`);
      results.push({
        persona: persona.name,
        visitedSteps: [],
        reachedGoodbye: false,
        callbackFlagged: false,
        trace: [],
        passed: false,
        failures: [`ERROR: ${msg}`],
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n  ${passed}/${results.length} personas passed\n`);
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  runConversationSuite({ verbose }).then((rs) => process.exit(rs.every((r) => r.passed) ? 0 : 1));
}

import { resolve } from 'node:path';
import { requireApiKey } from '../lib/env';
import { runAudioConversation, AudioConvoResult } from './audioConvo';

/**
 * Level 2 (audio) — full multi-turn voice conversations against the real gpt-realtime
 * model, headless over WebSocket. Each scenario injects patient TTS clips turn-by-turn
 * and asserts the agent branched correctly and reached the right ending.
 *
 *   npm run sim:audio
 */

export interface AudioScenario {
  name: string;
  patientTurns: string[];
  /** Substrings expected SOMEWHERE in the agent's speech (case-insensitive). */
  expectAgentSaid: string[];
  /** Substrings that must NOT appear (e.g. shouldn't ask later questions on a wrong number). */
  expectAgentNotSaid?: string[];
  expectGoodbye: boolean;
}

export const scenarios: AudioScenario[] = [
  {
    name: 'cooperative-home',
    patientTurns: ['English.', 'Yes, that is correct.', 'I feel as expected, pretty good.', 'The wait was too long.', 'I went home.'],
    expectAgentSaid: ['is that correct', 'how are you feeling', 'why did you leave', 'where did you go'],
    expectGoodbye: true,
  },
  {
    name: 'concerned-callback',
    patientTurns: ['English.', 'Yes.', "I have a concern, please have someone call me.", 'I felt worse.', 'I went to another ER.'],
    expectAgentSaid: ['call you back', 'where did you go'],
    expectGoodbye: true,
  },
  {
    name: 'wrong-number',
    patientTurns: ['English.', "No, that's not me. I was never at the ER."],
    expectAgentSaid: ['is that correct'],
    expectAgentNotSaid: ['why did you leave', 'where did you go'],
    expectGoodbye: true,
  },
];

function assertScenario(s: AudioScenario, r: AudioConvoResult): string[] {
  const failures: string[] = [];
  for (const phrase of s.expectAgentSaid) {
    if (!r.agentText.includes(phrase.toLowerCase())) failures.push(`agent never said "${phrase}"`);
  }
  for (const phrase of s.expectAgentNotSaid || []) {
    if (r.agentText.includes(phrase.toLowerCase())) failures.push(`agent unexpectedly said "${phrase}"`);
  }
  if (s.expectGoodbye && !r.reachedGoodbye) failures.push('never reached goodbye');
  return failures;
}

export async function runAudioSuite(verbose = false): Promise<{ passed: number; total: number }> {
  const apiKey = requireApiKey();
  console.log(`\n🎙️  Audio conversation suite — ${scenarios.length} scenarios (real gpt-realtime over WebSocket)\n`);

  let passed = 0;
  for (const s of scenarios) {
    process.stdout.write(`  ▶ ${s.name} ... `);
    try {
      const r = await runAudioConversation(apiKey, s.patientTurns, {
        clipsDir: resolve(process.cwd(), 'sim/realtime/clips', s.name),
      });
      const failures = assertScenario(s, r);
      const avg = r.latencies.length ? Math.round(r.latencies.reduce((a, b) => a + b, 0) / r.latencies.length) : 0;
      if (failures.length === 0) {
        passed++;
        console.log(`✅ pass (${r.turnsDelivered} turns, avg ${avg}ms)`);
      } else {
        console.log(`❌ fail — ${failures.join('; ')}`);
      }
      if (verbose || failures.length) {
        for (const line of r.agentLines) console.log(`      🤖 ${line}`);
        console.log('');
      }
    } catch (err) {
      console.log(`💥 ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n  ${passed}/${scenarios.length} audio scenarios passed\n`);
  return { passed, total: scenarios.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const verbose = process.argv.includes('-v') || process.argv.includes('--verbose');
  runAudioSuite(verbose).then((r) => process.exit(r.passed === r.total ? 0 : 1));
}

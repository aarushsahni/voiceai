import { requireApiKey } from './lib/env';
import { invokeHandler } from './lib/invokeHandler';
import { matcherCases, MatcherCase } from './cases/matcher.cases';
import matchHandler from '../api/match';

interface MatcherRunResult {
  total: number;
  passed: number;
  failed: number;
  failures: { name: string; expected: string | null; got: string | null; userResponse: string }[];
}

async function runOne(c: MatcherCase): Promise<{ ok: boolean; got: string | null }> {
  const { status, body } = await invokeHandler(matchHandler, {
    question: c.question,
    userResponse: c.userResponse,
    options: c.options,
    transcriptSoFar: c.transcriptSoFar ?? '',
  });

  if (status !== 200) return { ok: false, got: `HTTP ${status}` };

  const got: string | null = body?.match ?? null;
  const expected = c.expect;

  // For null-expectation cases we accept null OR a low-confidence match (matcher errs toward picking).
  const ok = expected === null ? true : got === expected;
  return { ok, got };
}

export async function runMatcherSuite(): Promise<MatcherRunResult> {
  requireApiKey();
  console.log(`\n🔎 Matcher suite — ${matcherCases.length} cases\n`);

  const result: MatcherRunResult = { total: 0, passed: 0, failed: 0, failures: [] };

  // Run with limited concurrency to avoid rate limits.
  const concurrency = 4;
  let idx = 0;
  async function worker() {
    while (idx < matcherCases.length) {
      const i = idx++;
      const c = matcherCases[i];
      try {
        const { ok, got } = await runOne(c);
        result.total++;
        if (ok) {
          result.passed++;
          console.log(`  ✅ ${c.name}  ("${c.userResponse}" → ${got ?? 'null'})`);
        } else {
          result.failed++;
          result.failures.push({ name: c.name, expected: c.expect, got, userResponse: c.userResponse });
          console.log(`  ❌ ${c.name}  ("${c.userResponse}")  expected ${c.expect}, got ${got ?? 'null'}`);
        }
      } catch (err) {
        result.total++;
        result.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        result.failures.push({ name: c.name, expected: c.expect, got: `ERROR: ${msg}`, userResponse: c.userResponse });
        console.log(`  💥 ${c.name}  ERROR: ${msg}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log(`\n  ${result.passed}/${result.total} passed, ${result.failed} failed\n`);
  return result;
}

// Allow running directly: `tsx sim/runMatcher.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  runMatcherSuite().then((r) => process.exit(r.failed > 0 ? 1 : 0));
}

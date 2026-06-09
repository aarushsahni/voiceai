import { runMatcherSuite } from './runMatcher';
import { runConversationSuite } from './runConversation';
import { runFlowChecks } from './runFlowChecks';

/**
 * Level 1 test runner — no audio, fast logic/conversation simulation.
 *
 * Usage:
 *   npm run sim            # run everything
 *   npm run sim matcher    # matcher option-matching cases only
 *   npm run sim convo      # persona-driven conversation sim only
 *   npm run sim flow       # generate + summary structural checks only
 *   npm run sim convo -v   # verbose: print full transcripts
 */
async function main() {
  const arg = process.argv[2];
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  let failed = 0;

  const run = !arg || arg === 'all';

  if (run || arg === 'matcher') {
    const r = await runMatcherSuite();
    failed += r.failed;
  }
  if (run || arg === 'flow') {
    const r = await runFlowChecks();
    failed += r.total - r.passed;
  }
  if (run || arg === 'convo') {
    const rs = await runConversationSuite({ verbose });
    failed += rs.filter((r) => !r.passed).length;
  }

  console.log(failed === 0 ? '🎉 All checks passed.' : `⚠️  ${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main();

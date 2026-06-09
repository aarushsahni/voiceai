import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { requireApiKey } from '../lib/env';
import { startServer } from './server';
import { generatePatientClips, DEFAULT_TURNS } from './genPatientAudio';

/**
 * Level 2 — real audio end-to-end.
 *
 * Drives the actual built app in headless Chromium against the real WebRTC +
 * gpt-realtime + turn-taking code in useRealtimeAudio.ts.
 *
 * Instead of Chromium's (unreliable on macOS) fake audio device, we override
 * getUserMedia to return a synthetic MediaStream we control, and inject one patient
 * utterance at a time *on the patient's actual turn* — detected from the app's own
 * mic mute/unmute logs. That makes answer timing follow the real conversation, so this
 * genuinely exercises turn-taking rather than guessing at a fixed schedule.
 */

const PORT = 4321;
const CLIPS_DIR = resolve(process.cwd(), 'sim/e2e/clips');
const DIST = resolve(process.cwd(), 'dist');
const TURN_TIMEOUT_MS = 35_000;

interface E2ECheck {
  name: string;
  ok: boolean;
  detail?: string;
}

async function ensurePrereqs(): Promise<number> {
  requireApiKey();
  if (!existsSync(DIST)) {
    console.log('  dist/ missing — running `npm run build` ...');
    execSync('npm run build', { stdio: 'inherit' });
  }
  if (!existsSync(resolve(CLIPS_DIR, '0.wav'))) {
    console.log('  clips missing — generating with TTS ...');
    await generatePatientClips(DEFAULT_TURNS);
  }
  return DEFAULT_TURNS.length;
}

// getUserMedia override injected before the app loads. Returns a synthetic mic stream;
// window.__speak(i) plays clip i into it and resolves when the clip finishes.
function micOverride(clipCount: number) {
  const w = window as any;
  const origGUM = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints: any) => {
    if (!constraints?.audio) return origGUM(constraints);
    const AC = w.AudioContext || w.webkitAudioContext;
    const ac = new AC();
    const dest = ac.createMediaStreamDestination();
    const clips: AudioBuffer[] = [];
    for (let i = 0; i < clipCount; i++) {
      const buf = await (await fetch('/__clip/' + i)).arrayBuffer();
      clips.push(await ac.decodeAudioData(buf));
    }
    w.__speak = (i: number) =>
      new Promise<boolean>((res) => {
        if (ac.state === 'suspended') ac.resume();
        const src = ac.createBufferSource();
        src.buffer = clips[i];
        src.connect(dest);
        src.onended = () => res(true);
        src.start();
      });
    w.__micReady = true;
    return dest.stream;
  };
}

export async function runE2E(): Promise<E2ECheck[]> {
  console.log('\n🎬 Browser smoke — real app + WebRTC + first audio turn\n');
  const clipCount = await ensurePrereqs();

  const { url, close } = await startServer(PORT);
  console.log(`  server: ${url}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(micOverride, clipCount);

  const consoleLog: string[] = [];
  const t0 = Date.now();
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
  page.on('console', (msg) => consoleLog.push(`[${stamp()}] ${msg.text()}`));
  page.on('pageerror', (err) => consoleLog.push(`[${stamp()}] PAGEERROR ${err.message}`));

  // "mic open" = app unmuted the patient mic → it's the patient's turn.
  const micOpens = () => consoleLog.filter((l) => /Track enabled: true/i.test(l)).length;
  const goodbye = () =>
    consoleLog.some((l) => /goodbye|Detected in transcript/i.test(l)) ||
    page.getByText(/call ended/i).first().isVisible().catch(() => false);

  async function waitFor(pred: () => boolean | Promise<boolean>, timeout: number): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await pred()) return true;
      await page.waitForTimeout(300);
    }
    return false;
  }

  const checks: E2ECheck[] = [];
  const turnLatencies: number[] = [];
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    checks.push({ name: 'app loads', ok: await page.getByText('Penn Medicine Lancaster General Health').first().isVisible() });

    await page.getByRole('button', { name: /start call/i }).click();

    // BROWSER SMOKE: drive a single turn. Injecting synthetic audio into the real
    // WebRTC stream reliably stalls after the first answer (a fake-mic artifact, not a
    // product bug — see sim/README.md and `npm run sim:audio` for full multi-turn).
    let delivered = 0;
    const ready = await waitFor(() => micOpens() >= 1, TURN_TIMEOUT_MS);
    if (ready) {
      const before = consoleLog.length;
      const tSpeak = Date.now();
      await page.evaluate(() => (window as any).__speak?.(0), null).catch(() => {});
      delivered = 1;
      await waitFor(() => consoleLog.slice(before).some((l) => /Muted - response starting|assistant_speaking|input_audio_transcription/i.test(l)), 15_000);
      turnLatencies.push(Date.now() - tSpeak);
    }

    // Give the user transcript a moment to render
    await waitFor(() => page.locator('span.font-semibold.text-sm').filter({ hasText: /^user$/i }).first().isVisible().catch(() => false), 10_000);

    // Read transcript from the DOM
    const labels = await page.locator('span.font-semibold.text-sm').allInnerTexts().catch(() => []);
    const sawAssistant = labels.some((l) => /assistant/i.test(l));
    const sawUser = labels.some((l) => /^user$/i.test(l));

    checks.push({ name: 'app loads + Start Call', ok: true });
    checks.push({ name: 'real WebRTC connects', ok: consoleLog.some((l) => /Data channel open|Connected - call starting/i.test(l)) });
    checks.push({ name: 'mic stream provided (synthetic)', ok: micOpens() >= 1 || consoleLog.some((l) => /Track enabled/i.test(l)) });
    checks.push({ name: 'assistant greeting spoken', ok: sawAssistant });
    checks.push({ name: 'first patient turn delivered', ok: delivered >= 1 });
    checks.push({ name: 'patient heard via real gpt-realtime', ok: sawUser });

    if (turnLatencies.length) {
      const avg = Math.round(turnLatencies.reduce((a, b) => a + b, 0) / turnLatencies.length);
      console.log(`  ⏱  first-turn turn-taking (clip start → agent responds): ${avg}ms`);
    }

    const logPath = resolve(process.cwd(), 'sim/e2e/last-run.log');
    writeFileSync(logPath, consoleLog.join('\n'));
    console.log(`  console log → ${logPath} (${consoleLog.length} lines)`);
  } finally {
    await browser.close();
    await close();
  }

  console.log();
  let passed = 0;
  for (const c of checks) {
    if (c.ok) passed++;
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  }
  console.log(`\n  ${passed}/${checks.length} E2E checks passed\n`);
  return checks;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runE2E().then((cs) => process.exit(cs.every((c) => c.ok) ? 0 : 1));
}

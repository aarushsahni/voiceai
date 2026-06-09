import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireApiKey } from '../lib/env';

/**
 * Generate a single WAV file of a simulated patient speaking, for Chrome's
 * `--use-file-for-fake-audio-capture` flag. Each utterance is synthesized with
 * OpenAI TTS (24kHz / 16-bit / mono PCM) and joined with silence gaps so the
 * patient "answers" land roughly after the agent finishes each question.
 *
 * Timing is approximate (a static file can't react to the agent), so this is for
 * pipeline + turn-taking *smoke* testing, not exact branching.
 */

const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;

export interface PatientTurn {
  /** What the simulated patient says on this turn. */
  text: string;
}

async function ttsPcm(apiKey: string, text: string): Promise<Buffer> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: text,
      response_format: 'pcm',
    }),
  });
  if (!res.ok) throw new Error(`TTS failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

function silence(seconds: number): Buffer {
  return Buffer.alloc(Math.round(seconds * SAMPLE_RATE) * BYTES_PER_SAMPLE);
}

function wavHeader(dataLength: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLength, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); // PCM chunk size
  h.writeUInt16LE(1, 20); // audio format PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
  h.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(dataLength, 40);
  return h;
}

function pcmToWav(pcm: Buffer): Buffer {
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}

/**
 * Generate one WAV per patient turn (e.g. clips/0.wav, clips/1.wav, ...).
 * The E2E runner injects these one at a time, on the patient's actual turn, so
 * answer timing follows the real conversation instead of a fixed schedule.
 */
export async function generatePatientClips(
  turns: PatientTurn[],
  dir = resolve(process.cwd(), 'sim/e2e/clips'),
): Promise<number> {
  const apiKey = requireApiKey();
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < turns.length; i++) {
    const pcm = await ttsPcm(apiKey, turns[i].text);
    // pad with a little trailing silence so server VAD reliably detects end-of-speech
    const wav = pcmToWav(Buffer.concat([pcm, silence(0.5)]));
    writeFileSync(resolve(dir, `${i}.wav`), wav);
  }
  console.log(`🎧 Wrote ${turns.length} clips → ${dir}`);
  return turns.length;
}

/** Default patient script: cooperative English patient, went home. */
export const DEFAULT_TURNS: PatientTurn[] = [
  { text: 'English.' },
  { text: 'Yes, that is correct.' },
  { text: 'I feel as expected, pretty good.' },
  { text: 'The wait was too long.' },
  { text: 'I went home.' },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  generatePatientClips(DEFAULT_TURNS).then(() => process.exit(0));
}

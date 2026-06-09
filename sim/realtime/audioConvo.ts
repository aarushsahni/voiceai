import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSystemPrompt, containsFinalPhrase } from '../../src/utils/scripts';
import { generatePatientClips } from '../e2e/genPatientAudio';

/**
 * Drive a full multi-turn AUDIO conversation against the real gpt-realtime model over a
 * WebSocket — headless, no browser/WebRTC. Replicates the app's session config
 * (server_vad, create_response:false, manual response.create per turn) and injects one
 * TTS clip per patient turn, paced in real time like a live mic.
 *
 * Pass `onEvent` to stream the call live (used by the web viewer, `npm run sim:watch`).
 */

export type SimEvent =
  | { type: 'status'; text: string }
  | { type: 'patient'; text: string; audioWavB64: string }
  | { type: 'heard'; text: string }
  | { type: 'agent'; text: string; audioPcmB64: string; latencyMs: number | null }
  | { type: 'done'; reachedGoodbye: boolean };

export interface AudioConvoResult {
  agentLines: string[];
  agentText: string; // concatenated, lowercased — for assertions
  reachedGoodbye: boolean;
  latencies: number[];
  turnsDelivered: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const silencePcm = (sec: number) => Buffer.alloc(Math.round(sec * 24000) * 2);

export async function runAudioConversation(
  apiKey: string,
  patientTurns: string[],
  opts: { clipsDir: string; voice?: string; patientName?: string; timeoutMs?: number; onEvent?: (e: SimEvent) => void } = { clipsDir: '' },
): Promise<AudioConvoResult> {
  const { clipsDir, voice = 'cedar', patientName = 'Maria', timeoutMs = 120000, onEvent } = opts;
  const emit = (e: SimEvent) => onEvent?.(e);

  if (!existsSync(resolve(clipsDir, '0.wav'))) {
    emit({ type: 'status', text: 'Synthesizing patient voice…' });
    await generatePatientClips(patientTurns.map((text) => ({ text })), clipsDir);
  }

  const instructions = getSystemPrompt('ed-followup-v1').replace(/\[patient_name\]/gi, patientName);
  const wavPcm = (i: number) => readFileSync(resolve(clipsDir, `${i}.wav`)).subarray(44);
  const wavFullB64 = (i: number) => readFileSync(resolve(clipsDir, `${i}.wav`)).toString('base64');

  return new Promise<AudioConvoResult>((resolveResult, reject) => {
    emit({ type: 'status', text: 'Connecting to gpt-realtime…' });
    const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime', ['realtime', 'openai-insecure-api-key.' + apiKey]);
    const send = (o: object) => ws.send(JSON.stringify(o));

    const agentLines: string[] = [];
    const latencies: number[] = [];
    let turnIndex = 0;
    let curTranscript = '';
    let curAudio: string[] = [];
    let responseActive = false;
    let injecting = false;
    let speechStoppedAt = 0;

    const finish = (reachedGoodbye: boolean) => {
      try { ws.close(); } catch { /* ignore */ }
      emit({ type: 'done', reachedGoodbye });
      resolveResult({ agentLines, agentText: agentLines.join(' \n ').toLowerCase(), reachedGoodbye, latencies, turnsDelivered: turnIndex });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    async function injectClip(i: number) {
      emit({ type: 'patient', text: patientTurns[i], audioWavB64: wavFullB64(i) });
      const pcm = Buffer.concat([wavPcm(i), silencePcm(0.6)]);
      const frameBytes = Math.round(24000 * 2 * 0.04);
      for (let off = 0; off < pcm.length; off += frameBytes) {
        send({ type: 'input_audio_buffer.append', audio: pcm.subarray(off, off + frameBytes).toString('base64') });
        await sleep(40);
      }
    }

    ws.addEventListener('open', () =>
      send({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions,
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              turn_detection: { type: 'server_vad', silence_duration_ms: 400, prefix_padding_ms: 200, threshold: 0.6, create_response: false },
              transcription: { model: 'gpt-4o-mini-transcribe' },
            },
            output: { format: { type: 'audio/pcm', rate: 24000 }, voice },
          },
          max_output_tokens: 1024,
        },
      }),
    );

    ws.addEventListener('error', (e: any) => { clearTimeout(timer); reject(new Error('WS error: ' + (e?.message || e))); });

    ws.addEventListener('message', async (ev: any) => {
      const data = JSON.parse(ev.data);
      switch (data.type as string) {
        case 'session.updated':
          emit({ type: 'status', text: 'Connected — starting call' });
          send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start the call now with your greeting and first question.' }] } });
          responseActive = true;
          send({ type: 'response.create', response: { output_modalities: ['audio'] } });
          break;

        case 'input_audio_buffer.speech_stopped':
          speechStoppedAt = Date.now();
          if (!responseActive) { responseActive = true; send({ type: 'response.create', response: { output_modalities: ['audio'] } }); }
          break;

        case 'conversation.item.input_audio_transcription.completed':
          if (data.transcript) emit({ type: 'heard', text: data.transcript.trim() });
          break;

        case 'response.created':
          responseActive = true;
          curTranscript = '';
          curAudio = [];
          break;

        case 'response.output_audio.delta':
        case 'response.audio.delta':
          if (data.delta) curAudio.push(data.delta);
          break;

        case 'response.output_audio_transcript.delta':
          curTranscript += data.delta || '';
          break;

        case 'response.output_audio_transcript.done': {
          const line = (data.transcript || curTranscript).trim();
          if (line) agentLines.push(line);
          let latencyMs: number | null = null;
          if (speechStoppedAt) { latencyMs = Date.now() - speechStoppedAt; latencies.push(latencyMs); speechStoppedAt = 0; }
          emit({ type: 'agent', text: line, audioPcmB64: curAudio.join(''), latencyMs });
          break;
        }

        case 'response.done': {
          responseActive = false;
          if (containsFinalPhrase(curTranscript)) { clearTimeout(timer); finish(true); return; }
          if (injecting || responseActive) break;
          if (turnIndex < patientTurns.length) {
            injecting = true;
            await sleep(300); // brief settle so we don't barge in on the agent's audio tail
            await injectClip(turnIndex++);
            injecting = false;
          } else {
            clearTimeout(timer);
            finish(false);
          }
          break;
        }

        case 'error':
          clearTimeout(timer);
          reject(new Error('realtime error: ' + JSON.stringify(data.error)));
          break;
      }
    });
  });
}

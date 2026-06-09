import { VercelRequest, VercelResponse } from '@vercel/node';
import WebSocket from 'ws';
import { getSystemPrompt, containsFinalPhrase } from '../src/utils/scripts';

/**
 * Streams a SIMULATED IVR call to the browser over SSE ("Watch a Call").
 *
 * Runs entirely server-side: opens a WebSocket to the real gpt-realtime model and
 * injects a scripted patient (synthesized with TTS, in memory) one turn at a time,
 * replicating the app's session config (server_vad, create_response:false, manual
 * response.create). The browser receives transcript + audio + status events and
 * renders the conversation + flow tree. The API key never leaves the server.
 */

export const maxDuration = 60;

const SCENARIOS: Record<string, { label: string; patientTurns: string[] }> = {
  'cooperative-home': {
    label: 'Cooperative patient (went home)',
    patientTurns: ['English.', 'Yes, that is correct.', 'I feel as expected, pretty good.', 'The wait was too long.', 'I went home.'],
  },
  'concerned-callback': {
    label: 'Concerned patient (wants a callback)',
    patientTurns: ['English.', 'Yes.', 'I have a concern, please have someone call me.', 'I felt worse.', 'I went to another ER.'],
  },
  'wrong-number': {
    label: 'Wrong number',
    patientTurns: ['English.', "No, that's not me. I was never at the ER."],
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    return;
  }

  // List scenarios for the dropdown.
  if (req.query.list !== undefined) {
    res.status(200).json(
      Object.entries(SCENARIOS).map(([name, s]) => ({ name, label: s.label, turns: s.patientTurns.length })),
    );
    return;
  }

  const scenarioName = String(req.query.scenario || 'cooperative-home');
  const scenario = SCENARIOS[scenarioName] || SCENARIOS['cooperative-home'];
  const patientName = typeof req.query.name === 'string' && req.query.name.trim() ? req.query.name.trim() : 'Maria';

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  await runConversation(apiKey, scenario.patientTurns, patientName, emit, req).catch((err) => {
    emit({ type: 'status', text: 'Error: ' + (err instanceof Error ? err.message : String(err)) });
    emit({ type: 'done', reachedGoodbye: false });
  });
  res.end();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** OpenAI TTS → raw PCM16 @ 24kHz (matches the realtime input format). */
async function ttsPcm(apiKey: string, text: string): Promise<Buffer> {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, response_format: 'pcm' }),
  });
  if (!r.ok) throw new Error('TTS failed: ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

function runConversation(
  apiKey: string,
  patientTurns: string[],
  patientName: string,
  emit: (e: unknown) => void,
  req: VercelRequest,
): Promise<void> {
  const instructions = getSystemPrompt('ed-followup-v1').replace(/\[patient_name\]/gi, patientName);
  const silence = (sec: number) => Buffer.alloc(Math.round(sec * 24000) * 2);

  return new Promise<void>((resolve, reject) => {
    emit({ type: 'status', text: 'Connecting to gpt-realtime…' });
    const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const send = (o: object) => ws.send(JSON.stringify(o));

    let turnIndex = 0;
    let curTranscript = '';
    let curAudio: string[] = [];
    let responseActive = false;
    let injecting = false;
    let speechStoppedAt = 0;
    let done = false;

    const finish = (reachedGoodbye: boolean) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* ignore */ }
      emit({ type: 'done', reachedGoodbye });
      resolve();
    };

    // Stop if the browser disconnects.
    req.on('close', () => finish(false));
    const timer = setTimeout(() => finish(false), 58000);

    async function injectClip(i: number) {
      const pcm = await ttsPcm(apiKey, patientTurns[i]);
      emit({ type: 'patient', text: patientTurns[i], audioPcmB64: pcm.toString('base64') });
      const framed = Buffer.concat([pcm, silence(0.6)]);
      const frameBytes = Math.round(24000 * 2 * 0.04);
      for (let off = 0; off < framed.length; off += frameBytes) {
        if (done) return;
        send({ type: 'input_audio_buffer.append', audio: framed.subarray(off, off + frameBytes).toString('base64') });
        await sleep(40);
      }
    }

    ws.on('open', () =>
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
            output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'cedar' },
          },
          max_output_tokens: 1024,
        },
      }),
    );

    ws.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
    ws.on('close', () => { clearTimeout(timer); finish(done ? true : false); });

    ws.on('message', async (raw: WebSocket.RawData) => {
      let data: any;
      try { data = JSON.parse(raw.toString()); } catch { return; }
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
          if (data.transcript) emit({ type: 'heard', text: String(data.transcript).trim() });
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
          let latencyMs: number | null = null;
          if (speechStoppedAt) { latencyMs = Date.now() - speechStoppedAt; speechStoppedAt = 0; }
          if (line) emit({ type: 'agent', text: line, audioPcmB64: curAudio.join(''), latencyMs });
          break;
        }

        case 'response.done': {
          responseActive = false;
          if (containsFinalPhrase(curTranscript)) { clearTimeout(timer); finish(true); return; }
          if (injecting || responseActive) break;
          if (turnIndex < patientTurns.length) {
            injecting = true;
            await sleep(300);
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

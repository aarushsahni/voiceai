import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Streams a SIMULATED IVR call to the browser over SSE ("Watch a Call").
 *
 * The browser POSTs the agent's instructions (the same system prompt used to conduct a
 * real call for the chosen script). The server opens a WebSocket to the real
 * gpt-realtime agent and plays a simulated patient against it: after each agent turn an
 * LLM generates the patient's next line, which is synthesized with TTS (in memory) and
 * injected as audio. Transcript + audio + status stream back over SSE.
 *
 * Self-contained (no imports from ../src) so the Vercel bundle can't fail to resolve
 * cross-directory files. The API key never leaves the server.
 */

export const maxDuration = 60;

const MAX_PATIENT_TURNS = 12;
const DEFAULT_PERSONA =
  'You are the patient receiving this call. Cooperate and give brief, natural, plausible ' +
  'answers to whatever the agent asks. When the agent lists spoken options, pick one of them. ' +
  'Keep replies to one short sentence, like real speech on a phone.';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = (req.body || {}) as { instructions?: string; patientName?: string; persona?: string };
  const instructions = (body.instructions || '').trim();
  if (!instructions) {
    res.status(400).json({ error: 'Missing instructions' });
    return;
  }
  const persona = (body.persona || '').trim() || DEFAULT_PERSONA;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  await runConversation(apiKey, instructions, persona, emit, req).catch((err) => {
    emit({ type: 'status', text: 'Error: ' + (err instanceof Error ? err.message : String(err)) });
    emit({ type: 'done', reachedGoodbye: false });
  });
  res.end();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FINAL_PHRASES = ['goodbye', 'bye', 'take care', 'adiós', 'adios', 'cuídese', 'cuidese'];
const containsFinalPhrase = (t: string) => { const l = t.toLowerCase(); return FINAL_PHRASES.some((p) => l.includes(p)); };

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

/** Generate the simulated patient's next spoken line from the conversation so far. */
async function patientReply(apiKey: string, persona: string, convo: { role: 'agent' | 'patient'; text: string }[]): Promise<string> {
  const transcript = convo.map((t) => `${t.role === 'agent' ? 'Agent' : 'You'}: ${t.text}`).join('\n');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 60,
      messages: [
        { role: 'system', content: `${persona}\n\nReply with ONLY what you say out loud — no narration or quotes. If the agent has clearly ended the call (said goodbye), reply with exactly: <END>` },
        { role: 'user', content: `Call so far:\n${transcript}\n\nYour next line:` },
      ],
    }),
  });
  if (!r.ok) throw new Error('patient LLM failed: ' + r.status);
  const data = await r.json();
  return (data.choices?.[0]?.message?.content || '').replace(/^["']|["']$/g, '').trim();
}

async function runConversation(
  apiKey: string,
  instructions: string,
  persona: string,
  emit: (e: unknown) => void,
  req: VercelRequest,
): Promise<void> {
  const silence = (sec: number) => Buffer.alloc(Math.round(sec * 24000) * 2);
  const { default: WebSocketImpl } = await import('ws');

  return new Promise<void>((resolve, reject) => {
    emit({ type: 'status', text: 'Connecting to gpt-realtime…' });
    const ws = new WebSocketImpl('wss://api.openai.com/v1/realtime?model=gpt-realtime', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const send = (o: object) => ws.send(JSON.stringify(o));

    const convo: { role: 'agent' | 'patient'; text: string }[] = [];
    let patientTurns = 0;
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
    req.on('close', () => finish(false));
    const timer = setTimeout(() => finish(false), 58000);

    async function injectText(text: string) {
      const pcm = await ttsPcm(apiKey, text);
      emit({ type: 'patient', text, audioPcmB64: pcm.toString('base64') });
      convo.push({ role: 'patient', text });
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
    ws.on('close', () => { clearTimeout(timer); finish(done); });

    ws.on('message', async (raw: Buffer) => {
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
          if (line) { emit({ type: 'agent', text: line, audioPcmB64: curAudio.join(''), latencyMs }); convo.push({ role: 'agent', text: line }); }
          break;
        }

        case 'response.done': {
          responseActive = false;
          if (containsFinalPhrase(curTranscript)) { clearTimeout(timer); finish(true); return; }
          if (injecting || responseActive) break;
          if (patientTurns >= MAX_PATIENT_TURNS) { clearTimeout(timer); finish(false); return; }
          injecting = true;
          try {
            emit({ type: 'status', text: 'Patient is responding…' });
            const reply = await patientReply(apiKey, persona, convo);
            if (!reply || reply.includes('<END>')) { clearTimeout(timer); finish(false); return; }
            patientTurns++;
            await injectText(reply);
          } finally {
            injecting = false;
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

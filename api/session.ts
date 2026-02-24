import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Creates an ephemeral token for browser WebRTC connection to OpenAI Realtime API (GA).
 * Uses /v1/realtime/client_secrets with the GA session config shape.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }

  try {
    const { 
      systemPrompt, 
      voice = 'cedar', 
      variableValues = {},
    } = req.body || {};

    let instructions = systemPrompt;
    
    if (!instructions || instructions.trim().length === 0) {
      instructions = getDefaultSystemPrompt();
    }
    
    console.log('[session] Received prompt length:', instructions.length);
    console.log('[session] Variable values:', JSON.stringify(variableValues));
    
    for (const [varName, value] of Object.entries(variableValues)) {
      if (value && typeof value === 'string') {
        const regex = new RegExp(`\\[${varName}\\]`, 'gi');
        const beforeCount = (instructions.match(regex) || []).length;
        if (beforeCount > 0) {
          instructions = instructions.replace(regex, value);
          console.log(`[session] Replaced ${beforeCount} [${varName}] → "${value}"`);
        }
      }
    }
    
    const remainingPlaceholders = instructions.match(/\[[a-z0-9_]+\]/gi);
    if (remainingPlaceholders) {
      console.log('[session] WARNING: Removing unfilled placeholders:', remainingPlaceholders);
    }
    instructions = instructions.replace(/\[[a-z0-9_]+\]/gi, '');
    instructions = instructions.replace(/,\s*,/g, ',');
    instructions = instructions.replace(/\s{2,}/g, ' ');

    const sessionConfig: Record<string, any> = {
      type: 'realtime',
      model: 'gpt-4o-realtime-preview-2024-12-17',
      instructions: instructions.trim(),
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'whisper-1' },
          noise_reduction: { type: 'near_field' },
          turn_detection: {
            type: 'server_vad',
            silence_duration_ms: 600,
            prefix_padding_ms: 300,
            threshold: 0.5,
            create_response: true,
          },
        },
        output: {
          voice: voice,
          format: { type: 'audio/pcm', rate: 24000 },
        },
      },
      max_output_tokens: 1024,
    };

    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session: sessionConfig }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI session error:', errorText);
      let parsedError: any = null;
      try { parsedError = JSON.parse(errorText); } catch { /* raw text */ }
      return res.status(response.status).json({ 
        error: `Failed to create session: ${response.statusText}`,
        details: errorText,
        openaiError: parsedError?.error || parsedError || errorText,
      });
    }

    const data = await response.json();
    console.log('[session] GA response keys:', Object.keys(data));
    
    const clientSecret = data.client_secret || data;
    
    return res.status(200).json({
      client_secret: clientSecret,
      expires_at: clientSecret.expires_at || data.expires_at,
    });
  } catch (error) {
    console.error('Session creation error:', error);
    return res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to create session' 
    });
  }
}

function getDefaultSystemPrompt(): string {
  return `
Penn Medicine LGH ED follow-up call. Be warm and conversational.

START (say this first): "Hi [patient_name], this is Penn Medicine Lancaster General Health calling about your recent emergency room visit. To continue in English, please say 'English'. Para continuar en español, por favor diga 'Español'."

ENGLISH FLOW:
1. User says English → "Thank you. We care about your recovery and want to check in with you. I'll ask you a few short questions about how you're doing. Our records show you recently left the emergency department before your visit was complete. Is that correct? Please say 'Yes' or 'No'."
2. User confirms Yes → "Ok, thank you for confirming. This call has three quick questions. You can say 'Repeat' anytime to hear a question again. First, how are you feeling since leaving the ER? Please say 'As expected' if you're feeling as expected, or say 'Have a concern' if you'd like someone to call you back."
   User says No → "No problem, sorry to have bothered you. Goodbye." [END]
3. User says expected → "I'm glad to hear that. Next question: Why did you leave the ER before your visit was finished? You can say 'Wait was too long', 'I felt better', or 'I felt worse'."
   User says concern → "I understand. We'll have someone from our care team call you back. Next question: Why did you leave the ER before your visit was finished? You can say 'Wait was too long', 'I felt better', or 'I felt worse'."
4. User answers reason → "Got it, thank you. Last question: Where did you go after leaving? Please say 'Went home', 'Went to another ER', or 'Went somewhere else'."
5. User answers disposition → "Got it, thank you. If you have any serious health concerns, please contact your doctor or seek emergency care. Thank you for your time today. Take care, goodbye!" [END]

SPANISH FLOW:
1. User says Español → "Gracias. Nos preocupamos por su recuperación y queremos saber cómo está. Le haré unas preguntas cortas sobre cómo se encuentra. Nuestros registros muestran que usted salió del departamento de emergencias antes de completar su visita. ¿Es correcto? Por favor diga 'Sí' o 'No'."
2. User confirms Sí → "Está bien, gracias por confirmar. Esta llamada tiene tres preguntas rápidas. Puede decir 'Repetir' en cualquier momento para escuchar una pregunta de nuevo. Primero, ¿cómo se siente desde que salió de la sala de emergencias? Por favor diga 'Como esperaba' si se siente como esperaba, o diga 'Tengo una preocupación' si desea que alguien le devuelva la llamada."
   User says No → "No hay problema, disculpe la molestia. Adiós." [END]
3. User says esperaba → "Me alegra escuchar eso. Siguiente pregunta: ¿Por qué salió de emergencias antes de terminar su visita? Puede decir 'La espera fue muy larga', 'Me sentí mejor' o 'Me sentí peor'."
   User says preocupación → "Entiendo. Alguien de nuestro equipo de atención le devolverá la llamada. Siguiente pregunta: ¿Por qué salió de emergencias antes de terminar su visita? Puede decir 'La espera fue muy larga', 'Me sentí mejor' o 'Me sentí peor'."
4. User answers reason → "Entendido, gracias. Última pregunta: ¿A dónde fue después de salir? Por favor diga 'Fui a casa', 'Fui a otra sala de emergencias' o 'Fui a otro lugar'."
5. User answers disposition → "Entendido, gracias. Si tiene alguna preocupación de salud seria, por favor contacte a su médico o busque atención de emergencia. Gracias por su tiempo hoy. ¡Cuídese, adiós!" [END]

If unclear: "Sorry, I didn't catch that." then repeat current question.
Accept natural variations: "home"/"went home", "yes"/"yeah"/"correct", etc.
`.trim();
}

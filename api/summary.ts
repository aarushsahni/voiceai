import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Generate a summary of the call from the conversation timeline.
 * Same logic as generate_call_summary in voice5.py
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
    const { timeline, needsCallback, callbackReasons } = req.body || {};

    if (!timeline || !Array.isArray(timeline) || timeline.length === 0) {
      return res.status(200).json({ summary: 'No conversation recorded.' });
    }

    // Build conversation transcript
    const transcriptLines: string[] = [];
    for (const entry of timeline) {
      const speaker = entry.role || 'unknown';
      const text = (entry.text || '').trim();
      if (text) {
        if (speaker === 'user') {
          transcriptLines.push(`Patient: ${text}`);
        } else if (speaker === 'assistant') {
          transcriptLines.push(`Agent: ${text}`);
        }
      }
    }

    if (transcriptLines.length === 0) {
      return res.status(200).json({ summary: 'No conversation content to summarize.' });
    }

    const transcript = transcriptLines.join('\n');

    // Create a simple local summary as fallback
    const makeLocalSummary = () => {
      const numTurns = transcriptLines.filter(l => l.startsWith('Patient:')).length;
      const patientSaid = transcriptLines
        .filter(l => l.startsWith('Patient:'))
        .map(l => l.replace('Patient: ', ''));
      const preview = patientSaid.slice(0, 3).join('; ');
      return `Call completed with ${numTurns} patient responses. Patient statements: ${preview}${patientSaid.length > 3 ? '...' : ''}`;
    };

    // Build context about callback status
    const callbackContext = needsCallback 
      ? `\n\nIMPORTANT: This call has been flagged for clinical callback. Reasons: ${(callbackReasons || []).join(', ')}`
      : '\n\nNo callback required - patient reported no concerns.';

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You summarize medical IVR call transcripts for clinical review.

CRITICAL RULES:
1. ONLY report information that was EXPLICITLY stated in the transcript
2. DO NOT infer, assume, or make up any details
3. If information was not discussed, say "Not discussed" or omit it
4. Use direct quotes when possible for patient statements
5. Be factual and objective - no interpretation

Format:
- Call outcome: [completed/incomplete/wrong number]
- Callback needed: [Yes/No]
- Patient responses: [quote their actual words]
- Key information gathered: [only what was explicitly said]

Keep it concise (2-4 sentences). Only include facts from the transcript.`,
          },
          {
            role: 'user',
            content: `Summarize this call based ONLY on what was said:${callbackContext}\n\nTranscript:\n${transcript}`,
          },
        ],
        temperature: 0.1,  // Lower temperature for more factual output
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      console.error('OpenAI summary error:', await response.text());
      return res.status(200).json({ summary: makeLocalSummary() });
    }

    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content?.trim();

    if (!summary) {
      return res.status(200).json({ summary: makeLocalSummary() });
    }

    return res.status(200).json({ summary });
  } catch (error) {
    console.error('Summary error:', error);
    return res.status(200).json({ 
      summary: 'Call completed. Unable to generate detailed summary.' 
    });
  }
}

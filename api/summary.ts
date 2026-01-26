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
Return ONLY valid JSON with this schema:
{
  "outcome": "completed" | "incomplete" | "wrong_number" | "no_answer",
  "callbackNeeded": boolean,
  "patientResponses": [string],  // Short phrases summarizing each key response
  "keyFindings": string,  // 1-2 sentence summary of important information
  "language": "English" | "Spanish" | "Unknown"
}

CRITICAL RULES:
1. ONLY report information that was EXPLICITLY stated in the transcript
2. DO NOT infer, assume, or make up any details
3. patientResponses should be short labels like "Feeling as expected", "Left because wait was too long", "Went home after"
4. Be factual and objective - no interpretation
5. If call didn't complete, set outcome appropriately`,
          },
          {
            role: 'user',
            content: `Summarize this call based ONLY on what was said:${callbackContext}\n\nTranscript:\n${transcript}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      console.error('OpenAI summary error:', await response.text());
      return res.status(200).json({ 
        summary: {
          outcome: 'completed',
          callbackNeeded: needsCallback || false,
          patientResponses: [],
          keyFindings: makeLocalSummary(),
          language: 'Unknown'
        }
      });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) {
      return res.status(200).json({ 
        summary: {
          outcome: 'completed',
          callbackNeeded: needsCallback || false,
          patientResponses: [],
          keyFindings: makeLocalSummary(),
          language: 'Unknown'
        }
      });
    }

    // Parse JSON response
    try {
      const parsed = JSON.parse(content);
      return res.status(200).json({ 
        summary: {
          outcome: parsed.outcome || 'completed',
          callbackNeeded: parsed.callbackNeeded ?? (needsCallback || false),
          patientResponses: parsed.patientResponses || [],
          keyFindings: parsed.keyFindings || '',
          language: parsed.language || 'Unknown'
        }
      });
    } catch {
      // Fallback if JSON parsing fails
      return res.status(200).json({ 
        summary: {
          outcome: 'completed',
          callbackNeeded: needsCallback || false,
          patientResponses: [],
          keyFindings: content,
          language: 'Unknown'
        }
      });
    }
  } catch (error) {
    console.error('Summary error:', error);
    return res.status(200).json({ 
      summary: {
        outcome: 'unknown',
        callbackNeeded: false,
        patientResponses: [],
        keyFindings: 'Call completed. Unable to generate detailed summary.',
        language: 'Unknown'
      }
    });
  }
}

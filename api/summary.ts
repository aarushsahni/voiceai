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
      return res.status(200).json({ summary: {
        outcome: 'no_answer',
        callbackNeeded: false,
        patientResponses: [],
        keyFindings: 'No conversation recorded.',
        language: 'Unknown',
        callbackActions: [],
        reminderActions: [],
      }});
    }

    const transcript = transcriptLines.join('\n');
    const transcriptLower = transcript.toLowerCase();

    // Create a simple local summary as fallback
    const makeLocalSummary = () => {
      const numTurns = transcriptLines.filter(l => l.startsWith('Patient:')).length;
      const patientSaid = transcriptLines
        .filter(l => l.startsWith('Patient:'))
        .map(l => l.replace('Patient: ', ''));
      const preview = patientSaid.slice(0, 3).join('; ');
      return `Call completed with ${numTurns} patient responses. Patient statements: ${preview}${patientSaid.length > 3 ? '...' : ''}`;
    };

    // Build context about callback status — only state facts, never assume patient intent
    let callbackContext = '';
    if (needsCallback) {
      callbackContext = `\n\nThis call has been flagged for clinical callback. Reasons: ${(callbackReasons || []).join(', ')}`;
    }

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
  "language": "English" | "Spanish" | "Unknown",
  "callbackActions": [string],  // Actions where team will call patient back
  "reminderActions": [string]   // Non-callback follow-up reminders/promised actions
}

CRITICAL RULES:
1. ONLY report information that was EXPLICITLY stated in the transcript
2. DO NOT infer, assume, or make up any details
3. patientResponses should be short labels like "Feeling as expected", "Left because wait was too long", "Went home after"
4. Be factual and objective - no interpretation
5. If call didn't complete, set outcome appropriately
6. callbackActions: Include ONLY confirmed callback-type actions (team will call patient back).
7. reminderActions: Include ONLY confirmed non-callback follow-up actions (e.g., reminder message, lab slips mailed, records update).
8. DO NOT include actions that were merely described as options but not selected by the patient.`,
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
          language: 'Unknown',
          callbackActions: [],
          reminderActions: [],
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
          language: 'Unknown',
          callbackActions: [],
          reminderActions: [],
        }
      });
    }

    // Parse JSON response
    try {
      const parsed = JSON.parse(content);
      const { callbackActions, reminderActions } = normalizeActions(
        parsed.callbackActions || [],
        parsed.reminderActions || [],
        transcriptLower
      );
      return res.status(200).json({ 
        summary: {
          outcome: parsed.outcome || 'completed',
          callbackNeeded: parsed.callbackNeeded ?? (needsCallback || false),
          patientResponses: parsed.patientResponses || [],
          keyFindings: parsed.keyFindings || '',
          language: parsed.language || 'Unknown',
          callbackActions,
          reminderActions,
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
          language: 'Unknown',
          callbackActions: [],
          reminderActions: [],
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
        language: 'Unknown',
        callbackActions: [],
        reminderActions: [],
      }
    });
  }
}

function normalizeActions(
  callbackRaw: string[],
  reminderRaw: string[],
  transcriptLower: string
): { callbackActions: string[]; reminderActions: string[] } {
  const callbackMarkers = ['call back', 'callback', 'call the patient', 'team will call', 'someone will call'];
  const reminderMarkers = ['reminder', 'mail', 'lab slip', 'records', 'follow up', 'follow-up'];

  const clean = (arr: string[]) =>
    arr
      .filter((a) => typeof a === 'string')
      .map((a) => a.trim())
      .filter((a) => a.length > 0);

  const unique = (arr: string[]) => Array.from(new Set(arr));

  const hasEvidence = (action: string): boolean => {
    const lower = action.toLowerCase();
    const keywords = lower
      .split(/[^a-z0-9]+/g)
      .filter((w) => w.length >= 4)
      .filter((w) => !['patient', 'action', 'scheduled', 'message', 'someone', 'team'].includes(w));
    if (keywords.length === 0) return true;
    return keywords.some((kw) => transcriptLower.includes(kw));
  };

  let callbackActions = clean(callbackRaw);
  let reminderActions = clean(reminderRaw);

  // If model accidentally puts callback actions into reminders, move them.
  const movedToCallback: string[] = [];
  reminderActions = reminderActions.filter((action) => {
    const lower = action.toLowerCase();
    const isCallback = callbackMarkers.some((m) => lower.includes(m));
    if (isCallback) movedToCallback.push(action);
    return !isCallback;
  });
  callbackActions.push(...movedToCallback);

  // If model accidentally puts pure reminder actions into callbacks, move them.
  const movedToReminder: string[] = [];
  callbackActions = callbackActions.filter((action) => {
    const lower = action.toLowerCase();
    const isCallback = callbackMarkers.some((m) => lower.includes(m));
    const isReminder = reminderMarkers.some((m) => lower.includes(m));
    if (!isCallback && isReminder) movedToReminder.push(action);
    return isCallback || !isReminder;
  });
  reminderActions.push(...movedToReminder);

  callbackActions = unique(callbackActions).filter(hasEvidence);
  reminderActions = unique(reminderActions).filter(hasEvidence);

  return { callbackActions, reminderActions };
}

import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Generates or converts a custom script to a system prompt format.
 * Uses GPT-4 to convert SMS/IVR scripts or generate from open-ended prompts.
 * Returns both system prompt AND flow map (like voice5.py).
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
    const { script, inputType, mode } = req.body || {};

    if (!script || typeof script !== 'string') {
      return res.status(400).json({ error: 'Script text is required' });
    }

    const systemInstructions = buildConversionInstructions();
    const userMessage = buildUserMessage(script, inputType, mode);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemInstructions },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 6000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI error:', errorText);
      return res.status(response.status).json({
        error: `Failed to generate script: ${response.statusText}`,
      });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return res.status(500).json({ error: 'No response generated' });
    }

    // Parse JSON response
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // If not valid JSON, try to extract from markdown code block
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1].trim());
      } else {
        return res.status(500).json({ error: 'Failed to parse response as JSON' });
      }
    }

    return res.status(200).json({
      systemPrompt: parsed.system_prompt || '',
      finalPhrases: parsed.final_phrases || ['goodbye', 'bye', 'take care'],
      flowMap: parsed.flow || null,
    });
  } catch (error) {
    console.error('Generation error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to generate script',
    });
  }
}

function buildConversionInstructions(): string {
  return `You convert medical IVR content into a system prompt for a realtime voice agent.
Return ONLY valid JSON with this schema:
{
  "system_prompt": string,
  "final_phrases": [string],
  "flow": {
    "title": string,
    "steps": [
      {
        "id": string,
        "label": string,
        "question": string,
        "info": string,
        "options": [
          {"label": string, "keywords": [string], "next": string}
        ]
      }
    ]
  }
}

AGENT PERSONALITY:
Warm, helpful, quick-talking; conversationally human but never claim to be human.

IMPORTANT RULES:
1. ALWAYS start with 'Hi [patient_name], this is Penn Medicine calling...' - use EXACTLY '[patient_name]' as the placeholder (it will be replaced with the actual name). NEVER make up a patient name.
2. Combine related questions into single conversational turns where possible (e.g. 'How are you feeling, and have you noticed any changes?').
3. Use warm, empathetic, human-like language. Add natural phrases like 'I understand', 'Thank you for sharing that', 'That's helpful to know'.
4. The voice should sound kind and caring, not robotic. Use conversational phrasing.
5. CRITICAL: The VERY LAST sentence of the script MUST contain the word 'goodbye' - this triggers call end detection. Example: 'Take care, goodbye!' or 'Thank you, goodbye!'
6. final_phrases MUST include: ['goodbye', 'take care', 'bye']
7. Each flow step's 'options' should include 'keywords' array with multiple ways a human might express that answer.
   Example: for 'yes', keywords could be ['yes', 'yeah', 'yep', 'correct', 'that is right', 'uh huh', 'mhm']
8. Preserve clinical meaning. No extra medical advice beyond disclaimer.
9. Deterministic mode: enforce verbatim reading of key clinical phrases.
10. Explorative mode: keep same topics/order, allow open-ended follow-up questions.
11. Include the personality description in the system_prompt so the voice agent knows how to behave.
12. If the patient expresses ANY concerning symptoms or urgent issues, ALWAYS say: 'I'll make sure the care team knows about this, and someone will call you back soon.'
13. Add a flow option for 'concerning/urgent' responses that routes to a message about the care team calling back.
14. BEFORE saying goodbye, ALWAYS ask 'Is there anything else I can help you with today?' or 'Do you have any other questions or concerns?'
15. Only proceed to goodbye AFTER the patient explicitly says 'no', 'nothing else', 'that's all', etc. Keep asking if they have concerns until they confirm no.
16. The goodbye message should be a complete sentence that the agent can finish saying. Don't cut off mid-sentence.
`;
}

function buildUserMessage(script: string, inputType: string, mode: string): string {
  const modeDesc = mode === 'explorative' 
    ? 'EXPLORATIVE (natural conversation, open-ended within topics)'
    : 'DETERMINISTIC (follow script verbatim)';

  if (inputType === 'prompt') {
    return `Mode: ${modeDesc}
Task: Generate a complete IVR script and flow from this open-ended prompt.
Remember: Start with Penn Medicine greeting, combine questions where logical, be warm and human, end with goodbye.
Prompt:
${script}
`;
  }

  return `Mode: ${modeDesc}
Task: Convert this script into a voice-agent system prompt and flow.
Remember: Start with Penn Medicine greeting, combine questions where logical, be warm and human, end with goodbye.
Script:
${script}
`;
}

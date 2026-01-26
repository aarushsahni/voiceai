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
2. Combine related questions into single conversational turns where possible.
3. Use warm, empathetic, human-like language.
4. CRITICAL: The VERY LAST sentence MUST contain 'goodbye' - this triggers call end detection.
5. final_phrases MUST include: ['goodbye', 'take care', 'bye']
6. Each option should include 'keywords' array with multiple ways a human might express that answer.
7. CREATE GRANULAR OPTIONS FOR BETTER TRIAGE - Generate 3-6 specific options per question where appropriate to capture meaningful clinical distinctions. Include a "concerning/needs callback" option when relevant.
8. Preserve clinical meaning. No extra medical advice beyond disclaimer.
9. If patient expresses concerning symptoms, say: 'I'll make sure the care team knows, someone will call you back soon.'
10. BEFORE goodbye, ask 'Is there anything else I can help you with today?'
11. Only proceed to goodbye AFTER patient confirms no more questions.
`;
}

function buildUserMessage(script: string, inputType: string, mode: string): string {
  const modeDesc = mode === 'explorative' 
    ? 'EXPLORATIVE (natural conversation, open-ended within topics)'
    : 'DETERMINISTIC (follow script verbatim)';

  if (inputType === 'prompt') {
    return `Mode: ${modeDesc}
Task: Generate a complete IVR script and flow from this open-ended prompt.
Remember: Start with Penn Medicine greeting, use [patient_name] placeholder, be warm and human, end with goodbye.
Prompt:
${script}
`;
  }

  return `Mode: ${modeDesc}
Task: Convert this script into a voice-agent system prompt and flow.
Remember: Start with Penn Medicine greeting, use [patient_name] placeholder, be warm and human, end with goodbye.
Script:
${script}
`;
}

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
  return `You convert medical IVR content into a system prompt AND conversation flow map for a realtime voice agent.

Return ONLY valid JSON with this exact schema:
{
  "system_prompt": "string - the full instructions for the voice agent",
  "final_phrases": ["goodbye", "bye", "take care", ...],
  "flow": {
    "title": "string - title of this script",
    "steps": [
      {
        "id": "string - unique step identifier like 'language', 'confirm', 'status'",
        "label": "string - display label like 'Language Selection'",
        "question": "string - the question being asked at this step",
        "info": "string - brief description of what this step collects",
        "options": [
          {
            "label": "string - display label like 'English' or 'Yes'",
            "next": "string - next step id or 'END (reason)'"
          }
        ]
      }
    ]
  }
}

AGENT PERSONALITY:
Warm, helpful, conversational; never claim to be human.

CRITICAL RULES FOR system_prompt:
1. START with "Hi [patient_name], this is Penn Medicine calling..." - use EXACTLY '[patient_name]' as placeholder
2. Combine related questions into natural turns where possible
3. Use empathetic, human-like language ("I understand", "Thank you for sharing that")
4. The LAST sentence MUST contain "goodbye" to trigger call end detection
5. Preserve clinical meaning - no extra medical advice beyond disclaimer
6. For DETERMINISTIC mode: enforce verbatim reading of key phrases
7. For EXPLORATIVE mode: same topics/order but allow open-ended follow-ups
8. If patient expresses concerning symptoms, say "I'll make sure the care team knows, and someone will call you back soon."
9. BEFORE goodbye, ask "Is there anything else I can help you with?"
10. Include bilingual support (English/Spanish) if the original script has it
11. Handle "repeat" requests by repeating the current question

CRITICAL RULES FOR flow:
1. Each step must have a unique "id" (use lowercase, short identifiers)
2. Options should cover expected user responses
3. "next" should reference another step's id, or "END (reason)" for terminal states
4. Include all branching paths (e.g., both Yes and No responses)
5. Flow should match the conversation structure in system_prompt`;
}

function buildUserMessage(script: string, inputType: string, mode: string): string {
  const modeDesc = mode === 'explorative' 
    ? 'EXPLORATIVE (natural conversation, open-ended within topics)'
    : 'DETERMINISTIC (follow script verbatim)';

  if (inputType === 'prompt') {
    return `Mode: ${modeDesc}
    
Task: Generate a complete IVR voice agent system prompt AND flow map from this description.

User's description:
${script}

Generate a full conversation flow with greeting, questions, acknowledgments, and closing.
Return the response as valid JSON with system_prompt, final_phrases, and flow fields.`;
  }

  return `Mode: ${modeDesc}

Task: Convert this SMS/IVR script into a voice agent system prompt AND flow map.

Original script:
${script}

Convert to a natural voice conversation format while preserving the clinical intent.
Return the response as valid JSON with system_prompt, final_phrases, and flow fields.`;
}

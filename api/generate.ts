import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Generates or converts a custom script to a system prompt format.
 * Uses GPT-4 to convert SMS/IVR scripts or generate from open-ended prompts.
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
        max_tokens: 4000,
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
    const generatedPrompt = data.choices?.[0]?.message?.content;

    if (!generatedPrompt) {
      return res.status(500).json({ error: 'No response generated' });
    }

    return res.status(200).json({
      systemPrompt: generatedPrompt.trim(),
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

AGENT PERSONALITY:
Warm, helpful, conversational; never claim to be human.

CRITICAL RULES:
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

OUTPUT FORMAT:
Return ONLY the system prompt text that will be passed to the voice agent. No JSON, no markdown formatting.
The prompt should define the conversation flow step by step.`;
}

function buildUserMessage(script: string, inputType: string, mode: string): string {
  const modeDesc = mode === 'explorative' 
    ? 'EXPLORATIVE (natural conversation, open-ended within topics)'
    : 'DETERMINISTIC (follow script verbatim)';

  if (inputType === 'prompt') {
    return `Mode: ${modeDesc}
    
Task: Generate a complete IVR voice agent system prompt from this description.

User's description:
${script}

Generate a full conversation flow with greeting, questions, acknowledgments, and closing.`;
  }

  return `Mode: ${modeDesc}

Task: Convert this SMS/IVR script into a voice agent system prompt.

Original script:
${script}

Convert to a natural voice conversation format while preserving the clinical intent.`;
}

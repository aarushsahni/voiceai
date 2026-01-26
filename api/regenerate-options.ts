import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Regenerates options for a specific flow step.
 * Used when user wants to adjust the number of options for a question.
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
    const { question, currentOptions, targetCount, context } = req.body || {};

    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Question is required' });
    }

    const numOptions = targetCount || 4;

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
            content: `You generate response options for medical IVR questions.
Return ONLY valid JSON array of options with this schema:
[
  {"label": string, "keywords": [string], "next": string}
]

RULES:
1. Generate EXACTLY ${numOptions} options
2. Options should be specific and clinically meaningful for triage
3. Include severity gradations where appropriate (mild/moderate/severe)
4. Always include a "concerning/needs callback" option if the question relates to symptoms or problems
5. Each option needs a 'keywords' array with 3-5 ways a patient might express that answer
6. 'next' should be a logical next step ID (use snake_case like "check_symptoms", "schedule_callback", "continue", "end_call")
7. Make options mutually exclusive and comprehensive
8. Order from most positive to most concerning`
          },
          {
            role: 'user',
            content: `Generate ${numOptions} response options for this medical IVR question:

Question: "${question}"

${context ? `Context: ${context}` : ''}
${currentOptions && currentOptions.length > 0 ? `Current options for reference (regenerate with better triage): ${JSON.stringify(currentOptions)}` : ''}

Return a JSON array with exactly ${numOptions} options.`
          },
        ],
        temperature: 0.4,
        max_tokens: 1000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI error:', errorText);
      return res.status(response.status).json({
        error: `Failed to regenerate options: ${response.statusText}`,
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
      // Handle if response is wrapped in an object
      if (parsed.options && Array.isArray(parsed.options)) {
        parsed = parsed.options;
      }
    } catch {
      return res.status(500).json({ error: 'Failed to parse response as JSON' });
    }

    // Ensure we have an array
    if (!Array.isArray(parsed)) {
      return res.status(500).json({ error: 'Response is not an array of options' });
    }

    return res.status(200).json({ options: parsed });
  } catch (error) {
    console.error('Regeneration error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to regenerate options',
    });
  }
}

import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Match user's natural language response to expected options using LLM.
 * Same logic as match_answer_with_llm in voice5.py
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
    const { question, userResponse, options } = req.body || {};

    if (!userResponse || !options || !Array.isArray(options)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Build options string for the prompt
    const optionsStr = options
      .map((opt: { label: string }, i: number) => `${i + 1}. ${opt.label}`)
      .join('\n');

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
            content: `You match user responses to expected answer options.
Return ONLY a JSON object with: {"match": <option_number or 0 if no match>, "confidence": <0.0-1.0>}
If the user's response clearly indicates one of the options, return its number (1-indexed).
If unclear or doesn't match any option, return 0.`,
          },
          {
            role: 'user',
            content: `Question asked: ${question || 'N/A'}

User's response: "${userResponse}"

Expected options:
${optionsStr}

Which option does the user's response match?`,
          },
        ],
        temperature: 0.1,
        max_tokens: 50,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI match error:', errorText);
      return res.status(200).json({ match: null, matchedIndex: -1 });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return res.status(200).json({ match: null, matchedIndex: -1 });
    }

    const parsed = JSON.parse(content);
    const matchIdx = parsed.match || 0;

    if (matchIdx > 0 && matchIdx <= options.length) {
      const matchedOption = options[matchIdx - 1];
      return res.status(200).json({
        match: matchedOption.label,
        matchedIndex: matchIdx - 1,
        confidence: parsed.confidence || 0,
      });
    }

    return res.status(200).json({ match: null, matchedIndex: -1 });
  } catch (error) {
    console.error('Match error:', error);
    return res.status(200).json({ match: null, matchedIndex: -1 });
  }
}

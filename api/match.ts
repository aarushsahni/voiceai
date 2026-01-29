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
        model: 'gpt-5',
        messages: [
          {
            role: 'system',
            content: `You are a precise response matcher for medical IVR calls.
Return ONLY a JSON object with: {"match": <option_number or 0 if no match>, "confidence": <0.0-1.0>}

CRITICAL MATCHING RULES:
1. VOICE TRANSCRIPTION ERRORS - This is voice transcription which may contain errors from phonetically similar words. Match based on both phonetic similarity (words that sound alike) and semantic meaning (intended meaning).
2. EXACT OPTION MATCHING - If the transcript is exactly or nearly identical to one of the option texts, that's the correct match.
3. NEGATIONS - Pay close attention to negative words which reverse meaning.
4. COMPLETE MEANING - Match the full meaning and intent, not just isolated keywords.
5. NUMERIC VALUES - If an option contains a number and the patient said that number, match it.
6. AMBIGUITY - If truly ambiguous, return 0.

Be VERY careful - incorrect matches affect patient care.`,
          },
          {
            role: 'user',
            content: `Question: ${question || 'N/A'}

Patient said: "${userResponse}"

Options:
${optionsStr}

This is a voice transcript that may contain phonetic transcription errors. Consider both the literal words and what the patient likely intended to say. Match to the most appropriate option.`,
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

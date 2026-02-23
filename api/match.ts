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
    const { question, userResponse, options, transcriptSoFar } = req.body || {};
    console.log('[debug-match-api] request received:', {
      questionLength: (question || '').length,
      userResponse,
      optionsCount: Array.isArray(options) ? options.length : 0,
      options: Array.isArray(options) ? options.map((o: any, idx: number) => ({ idx, label: o?.label, next: o?.next })) : [],
      transcriptSoFarLength: (transcriptSoFar || '').length,
    });

    if (!userResponse || !options || !Array.isArray(options)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const normalizedOptions = options.filter((opt: any) => opt && typeof opt.label === 'string');
    if (!normalizedOptions.length) {
      return res.status(200).json({
        match: null,
        matchedIndex: -1,
        debug: { stage: 'invalid_options', receivedCount: options.length },
      });
    }

    // Build options string for the prompt (exact labels only)
    const optionsStr = normalizedOptions
      .map((opt: { label: string }, i: number) => `${i + 1}. ${opt.label}`)
      .join('\n');

    const callMatcher = async (strictPick: boolean) => {
      return fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-5.2',
          input: `You are a precise response matcher for medical IVR calls.
Return ONLY a JSON object with this exact schema:
{"match": <INTEGER option number, 1..N, or 0>, "confidence": <number 0.0-1.0>}

CRITICAL MATCHING RULES:
1. VOICE TRANSCRIPTION ERRORS - This is voice transcription which may contain errors from phonetically similar words. Match based on both phonetic similarity (words that sound alike) and semantic meaning (intended meaning).
2. EXACT OPTION MATCHING - If the transcript is exactly or nearly identical to one of the option texts, that's the correct match.
3. NEGATIONS - Pay close attention to negative words which reverse meaning.
4. COMPLETE MEANING - Match the full meaning and intent, not just isolated keywords.
5. NUMERIC VALUES - If an option contains a number and the patient said that number, match it.
6. AMBIGUITY - Return 0 only if none of the options are reasonably supported.
7. Prefer selecting one option when there is a reasonable closest match.${strictPick ? '\n8. STRICT PICK MODE: choose the best-supported option unless truly impossible.' : ''}

Be VERY careful - incorrect matches affect patient care.

Question: ${question || 'N/A'}

Patient said: "${userResponse}"

Transcript so far:
${transcriptSoFar || '(none)'}

Options:
${optionsStr}

Use full conversation context to disambiguate intent, but prioritize what the patient most recently said for this question.`,
          reasoning: { effort: 'low' },
        }),
      });
    };

    const response = await callMatcher(false);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI match error:', errorText);
      return res.status(200).json({
        match: null,
        matchedIndex: -1,
        debug: {
          stage: 'openai_first_pass_error',
          status: response.status,
          statusText: response.statusText,
          errorText: errorText.slice(0, 1200),
        },
      });
    }

    const data = await response.json();
    const content = extractResponsesContent(data);
    console.log('[debug-match-api] first pass extracted content:', content);
    console.log('[debug-match-api] first pass raw output:', data?.output);

    if (!content) {
      return res.status(200).json({
        match: null,
        matchedIndex: -1,
        debug: {
          stage: 'empty_content_first_pass',
          rawOutput: data?.output ?? null,
        },
      });
    }

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (parseError: any) {
      return res.status(200).json({
        match: null,
        matchedIndex: -1,
        debug: {
          stage: 'json_parse_error_first_pass',
          message: parseError?.message || 'unknown parse error',
          rawContent: String(content).slice(0, 1200),
        },
      });
    }
    let llmMatchIdx = extractMatchIndex(parsed.match, normalizedOptions);
    let llmConfidence = Number(parsed.confidence) || 0;
    console.log('[debug-match-api] first pass parsed:', { parsed, llmMatchIdx, llmConfidence });

    // LLM-only retry: if first pass returns 0, ask for best-supported pick unless truly impossible.
    if (llmMatchIdx === 0) {
      const retry = await callMatcher(true);
      if (retry.ok) {
        const retryData = await retry.json();
        const retryContent = extractResponsesContent(retryData);
        console.log('[debug-match-api] retry extracted content:', retryContent);
        console.log('[debug-match-api] retry raw output:', retryData?.output);
        if (retryContent) {
          try {
            const retryParsed = JSON.parse(retryContent);
            const retryIdx = extractMatchIndex(retryParsed.match, normalizedOptions);
            const retryConfidence = Number(retryParsed.confidence) || 0;
            console.log(`[match] retry raw: ${JSON.stringify(retryParsed)}, idx: ${retryIdx}, confidence: ${retryConfidence}`);
            if (retryIdx > 0 && retryIdx <= normalizedOptions.length) {
              llmMatchIdx = retryIdx;
              llmConfidence = retryConfidence;
              console.log(`[match] retry picked option ${retryIdx} (confidence ${retryConfidence})`);
            }
          } catch (retryParseError: any) {
            console.log('[debug-match-api] retry parse error:', retryParseError?.message || retryParseError);
            // keep original result
          }
        }
      }
    }

    const matchIdx = llmMatchIdx;

    console.log(
      `[match] User: "${userResponse}" → LLM: ${JSON.stringify(parsed)}, finalMatchIdx: ${matchIdx}, source: llm`
    );

    if (matchIdx > 0 && matchIdx <= normalizedOptions.length) {
      const matchedOption = normalizedOptions[matchIdx - 1];
      console.log(`[match] ✅ Matched to option ${matchIdx}: "${matchedOption.label}"`);
      return res.status(200).json({
        match: matchedOption.label,
        matchedIndex: matchIdx - 1,
        confidence: llmConfidence,
        debug: {
          stage: 'matched',
          llmMatchIdx,
          llmConfidence,
        },
      });
    }

    console.log(`[match] ❌ No valid match (idx=${matchIdx}, options count=${normalizedOptions.length})`);
    console.log('[debug-match-api] returning null match for request:', { userResponse, options: normalizedOptions.map((o: any) => o.label) });
    return res.status(200).json({
      match: null,
      matchedIndex: -1,
      debug: {
        stage: 'no_valid_match',
        llmMatchIdx,
        llmConfidence,
        parsed,
      },
    });
  } catch (error) {
    console.error('Match error:', error);
    return res.status(200).json({
      match: null,
      matchedIndex: -1,
      debug: {
        stage: 'handler_exception',
        error: String(error),
      },
    });
  }
}

function extractMatchIndex(rawMatch: unknown, options: Array<{ label: string }>): number {
  if (typeof rawMatch === 'number' && Number.isFinite(rawMatch)) {
    return Math.trunc(rawMatch);
  }

  if (typeof rawMatch === 'string') {
    const trimmed = rawMatch.trim();
    // "2", "2.", "option 2", "#2"
    const numMatch = trimmed.match(/(\d+)/);
    if (numMatch) {
      return Number(numMatch[1]) || 0;
    }

    // If model returned the option label text instead of an index, map it.
    const byLabel = options.findIndex((o) => o.label.toLowerCase() === trimmed.toLowerCase());
    if (byLabel >= 0) return byLabel + 1;
  }

  return 0;
}

function extractResponsesContent(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (!Array.isArray(data?.output)) return '';

  for (const item of data.output) {
    if (item?.type !== 'message' || !Array.isArray(item?.content)) continue;
    for (const part of item.content) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        return part.text.trim();
      }
    }
  }

  return '';
}

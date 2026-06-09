/**
 * Thin OpenAI Chat Completions helper for the conversation simulator.
 *
 * NOTE ON FIDELITY: the production call uses the `gpt-realtime` model over WebRTC.
 * That model is only reachable via the Realtime API, so the Level 1 simulator uses a
 * standard chat model as a stand-in for the IVR agent. This is a faithful proxy for
 * testing *branching, prompt adherence, and matching* — but NOT audio turn-taking.
 * Audio timing / barge-in is covered by the Level 2 (Playwright + fake audio) harness.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function chat(
  apiKey: string,
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const { model = 'gpt-4o', temperature = 0.6, maxTokens = 400 } = opts;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`chat ${model} failed: ${res.status} ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

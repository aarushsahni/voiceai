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

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5',
        input: `${systemInstructions}\n\n---\n\n${userMessage}`,
        reasoning: {
          effort: 'low'
        }
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
    
    // Extract content from gpt-5 response format
    // output array has reasoning block (type: "reasoning") and message block (type: "message")
    let content: string | null = null;
    if (data.output && Array.isArray(data.output)) {
      // Find the message block (not the reasoning block)
      const messageBlock = data.output.find((item: { type: string }) => item.type === 'message');
      if (messageBlock?.content && Array.isArray(messageBlock.content) && messageBlock.content[0]) {
        content = messageBlock.content[0].text;
      }
    }

    if (!content) {
      return res.status(500).json({ 
        error: 'No response generated', 
        availableFields: Object.keys(data),
        fullResponse: data 
      });
    }

    // Parse JSON response
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // If not valid JSON, try to extract from markdown code block
      if (typeof content === 'string') {
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[1].trim());
        } else {
          // Try to find JSON object in the response
          const jsonStart = content.indexOf('{');
          const jsonEnd = content.lastIndexOf('}');
          if (jsonStart !== -1 && jsonEnd !== -1) {
            parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
          } else {
            return res.status(500).json({ error: 'Failed to parse response as JSON', content });
          }
        }
      } else {
        return res.status(500).json({ error: 'Unexpected response format', content });
      }
    }

    return res.status(200).json({
      greeting: parsed.greeting || 'Hello, this is Penn Medicine calling about your recent visit.',
      scriptContent: parsed.script || '',  // Just the script steps, not full system prompt
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
  return `You generate SCRIPT CONTENT for a medical IVR voice agent.

Return ONLY valid JSON with this schema:
{
  "greeting": string,
  "script": string,
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
          {"label": string, "keywords": [string], "next": string, "triggers_callback": boolean}
        ]
      }
    ]
  }
}

CRITICAL REQUIREMENTS:
1. EXTRACT ALL TOPICS from the user's prompt and create a SEPARATE STEP for EACH topic. Read the prompt carefully and identify every distinct thing they want to ask about.
2. PRESERVE ALL SPECIFIC DETAILS from the user's prompt - medication names, equipment names, appointment dates/times, symptom types, etc. Include them verbatim in the questions.
3. CALLBACK HANDLING - Use ONE single callback step for all callback scenarios:
   - Create ONE step with id "callback" that says: "I'll make sure the care team knows about this, and someone will call you back soon."
   - Options that need callback should have "triggers_callback": true, "next": "callback", and "return_to": "[next_main_step_id]"
   - The callback step itself should NOT have a fixed "next" - the runtime will use "return_to" to continue
4. This ensures callbacks are handled consistently before continuing the flow.

SCRIPT FORMAT EXAMPLE:
"""
STEP symptoms - Check Symptoms:
Ask: "[Question about symptoms]"
- If improving: Acknowledge, go to medications
- If has concerns: Go to callback, return_to medications (triggers_callback: true)
- If unclear: Repeat question

STEP medications - Check Medications:
Ask: "[Question about medications]"
- If no issues: Acknowledge, go to equipment
- If has questions: Go to callback, return_to equipment (triggers_callback: true)

STEP callback - Callback:
Say: "I'll make sure the care team knows about this, and someone will call you back soon."
(Runtime uses return_to from the triggering option to continue)

STEP closing - Closing:
Ask: "Is there anything else I can help you with today?"
- If yes: Go to callback, return_to closing (triggers_callback: true)
- If no: Go to end_call

STEP end_call - End Call:
Say: "Thank you for your time today. Take care, goodbye!"
"""

FLOW RULES:
1. Greeting MUST include the first question: "Hi [patient_name], this is Penn Medicine calling... [first question]"
2. Use [patient_name] placeholder - never make up a name
3. Create a step for EVERY topic in the user's prompt - don't combine or skip any
4. Include specific names/dates/details from the prompt in your questions
5. Each option needs "next" pointing to an existing step ID
6. Callback options need: "triggers_callback": true, "next": "callback", "return_to": "[next_main_step_id]"
7. Include ONE "callback" step that says the callback message (runtime handles continuation via return_to)
8. Always include "closing" and "end_call" steps at the end
9. The LAST sentence must contain "goodbye"
10. final_phrases: ["goodbye", "take care", "bye"]
11. Each option needs a "keywords" array with natural variations
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

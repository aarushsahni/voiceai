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
NOTE: You are NOT generating the full system prompt - just the script steps that will be inserted into a base template.

Return ONLY valid JSON with this schema:
{
  "greeting": string,  // The exact first sentence (use [patient_name] placeholder)
  "script": string,    // The step-by-step script content (see format below)
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

THE "script" FIELD FORMAT - Generate step-by-step instructions like this:

"""
STEP 1 - [STEP_NAME]:
Ask: "[EXACT QUESTION TO ASK - be specific based on user's prompt]"
Wait for patient response, then:
- If they say [keywords]: Say "[response]" then go to [NEXT_STEP]
- If they say [other keywords]: Say "[response]" then go to [DIFFERENT_STEP]
- If concerning symptoms: Say "I'll make sure the care team knows about this, and someone will call you back soon." then go to CALLBACK
- If unclear: Say "I didn't quite catch that." then repeat the question

STEP 2 - [STEP_NAME]:
Ask: "[NEXT SPECIFIC QUESTION]"
Wait for patient response, then:
- If they say [keywords]: [Response and next step]
...

CALLBACK:
Say: "I want to make sure you get the help you need. Someone from our care team will call you back soon."
Then go to CLOSING

CLOSING:
Ask: "Is there anything else I can help you with today?"
- If they say [yes, actually, one more thing]: Address their concern, then ask again
- If they say [no, nothing, that's all]: Say "Thank you for your time today. Take care, goodbye!"
"""

IMPORTANT RULES:
1. ALWAYS start greeting with 'Hi [patient_name], this is Penn Medicine calling...' - use EXACTLY '[patient_name]' as the placeholder (it will be replaced with the actual name). NEVER make up a patient name.
2. ASK ONE QUESTION PER STEP - do not combine multiple questions. Each step should have exactly one question the patient needs to answer.
3. KEEP QUESTIONS SPECIFIC - preserve specific clinical details from the user's prompt (e.g., "How is your breathing?" not "How are you feeling?")
4. Use warm, empathetic, human-like language.
5. CRITICAL: The VERY LAST sentence MUST contain 'goodbye' - this triggers call end detection.
6. final_phrases MUST include: ['goodbye', 'take care', 'bye']
7. Each option should include 'keywords' array with multiple ways a human might express that answer.
8. CREATE GRANULAR OPTIONS FOR BETTER TRIAGE - Generate 3-6 specific options per question where appropriate to capture meaningful clinical distinctions. Include a "concerning/needs callback" option when relevant. Options should be descriptive (e.g., "Medication received, no questions" vs "Medication received, has questions" vs "Medication not received").
9. Preserve clinical meaning. No extra medical advice beyond disclaimer.
10. If patient expresses concerning symptoms, say: 'I'll make sure the care team knows, someone will call you back soon.'
11. BEFORE goodbye, ask 'Is there anything else I can help you with today?'
12. Only proceed to goodbye AFTER patient confirms no more questions.
13. The flow JSON should mirror ALL the steps in the script - every step in script = a step in flow.
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

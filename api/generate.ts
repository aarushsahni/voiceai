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
STEP check_symptoms - [Step Label]:
Ask: "[EXACT QUESTION TO ASK - be specific based on user's prompt]"
Wait for patient response, then:
- If they say [positive keywords]: Say "That's great to hear. [next question]" then go to check_medications
- If they say [concerning keywords]: Say "I'm sorry to hear that. I'll make sure the care team knows, someone will call you back soon. [next question]" then go to check_medications (CALLBACK TRIGGERED but continue flow)
- If unclear: Say "I didn't quite catch that." then repeat the question

STEP check_medications - [Step Label]:
Ask: "[NEXT SPECIFIC QUESTION]"
Wait for patient response, then:
- If they say [positive keywords]: Say "Good to know. [next question]" then go to check_equipment
- If they need callback: Say "Got it, thank you for letting me know. I'll make sure the care team knows, someone will call you back soon. [next question]" then go to check_equipment (CALLBACK TRIGGERED but continue flow)
...

STEP closing - Closing:
Ask: "Is there anything else I can help you with today?"
- If they say [yes, actually, one more thing]: Address their concern, then ask again
- If they say [no, nothing, that's all]: Go to end_call

STEP end_call - End Call:
Say: "Thank you for your time today. Take care, goodbye!"
"""

CALLBACK HANDLING - CRITICAL:
- When a patient needs a callback (concerning symptoms, questions, etc.), say the callback message BUT THEN CONTINUE to the NEXT step
- The "next" field for callback options should point to the next step in the flow, NOT to a separate callback step
- Example: In check_medications, if patient has questions, say callback message then go to check_equipment
- This ensures ALL steps are completed even when callbacks are triggered
- For the flow.steps array, mark callback options with a "triggers_callback": true property if needed for tracking

IMPORTANT RULES:
1. The greeting MUST include the first question in the same sentence - do NOT have a standalone greeting. Example: "Hi [patient_name], this is Penn Medicine calling about your recent visit. How are you feeling today?" Use EXACTLY '[patient_name]' as the placeholder. NEVER make up a patient name.
2. ALWAYS include acknowledgment statements in each step's response before asking the next question. Examples:
   - Positive: "That's great to hear.", "I'm glad to hear that.", "Good to know."
   - Neutral: "Got it, thank you.", "Okay, thanks for letting me know."
   - Concerning: "I'm sorry to hear that.", "Thank you for sharing that."
3. COMBINE RELATED QUESTIONS into single conversational turns where appropriate (e.g., "How are you feeling? Any changes in your breathing or pain?"). But don't ask ALL questions at once.
4. KEEP QUESTIONS SPECIFIC - preserve specific clinical details from the user's prompt (e.g., "How is your breathing?" not "How are you feeling?")
5. Use warm, empathetic, human-like language.
6. CRITICAL: The VERY LAST sentence MUST contain 'goodbye' - this triggers call end detection.
7. final_phrases MUST include: ['goodbye', 'take care', 'bye']
8. Each option should include 'keywords' array with multiple ways a human might express that answer.
9. CREATE GRANULAR OPTIONS FOR BETTER TRIAGE - Generate 3-6 specific options per question where appropriate to capture meaningful clinical distinctions. Include a "concerning/needs callback" option when relevant. Options should be descriptive (e.g., "Medication received, no questions" vs "Medication received, has questions" vs "Medication not received").
10. Preserve clinical meaning. No extra medical advice beyond disclaimer.
11. CALLBACK HANDLING: When patient needs a callback (concerning symptoms, questions, etc.), say "I'll make sure the care team knows, someone will call you back soon." BUT THEN CONTINUE TO THE NEXT STEP - do NOT skip to closing. ALL steps must still be completed.
12. Only ask 'Is there anything else I can help you with today?' AFTER completing ALL script steps (this is the "closing" step).
13. Only proceed to goodbye AFTER patient confirms no more questions.
14. CRITICAL - EVERY STEP REFERENCED IN "next" MUST EXIST IN THE FLOW:
    - ALL steps mentioned in the script must be defined in the flow.steps array
    - The "next" field in options must use exact step IDs that exist in the flow
    - Always include: a "closing" step (anything else?) and an "end_call" step (goodbye)
    - Use snake_case IDs like: "check_symptoms", "check_medications", "closing", "end_call"
15. CALLBACK OPTIONS - Mark options that trigger callback with "triggers_callback": true in the option object. The "next" field should still point to the NEXT step in the flow (not a separate callback step). Example option: {"label": "Has questions", "keywords": ["question", "help"], "next": "check_equipment", "triggers_callback": true}
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

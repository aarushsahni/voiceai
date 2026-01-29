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
        model: 'gpt-5.2',
        input: `${systemInstructions}\n\n---\n\n${userMessage}`,
        reasoning: {
          effort: 'medium'
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
      variables: parsed.variables || [],  // List of variable placeholders used (e.g., ["street_address", "practice_number"])
    });
  } catch (error) {
    console.error('Generation error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to generate script',
    });
  }
}

function buildConversionInstructions(): string {
  return `You convert SMS survey scripts OR open prompts into IVR voice agent scripts.

Return ONLY valid JSON with this schema:
{
  "greeting": string,
  "script": string,
  "final_phrases": [string],
  "variables": [string],
  "flow": {
    "title": string,
    "steps": [
      {
        "id": string,
        "label": string,
        "type": "question" | "statement",
        "question": string,
        "info": string,
        "options": [
          {"label": string, "keywords": [string], "next": string, "triggers_callback": boolean}
        ]
      }
    ]
  }
}

STEP TYPES:
- "question" (default): Ask something and wait for patient response
- "statement": Say information, then auto-continue to the next step (no response needed)

VARIABLE PLACEHOLDERS:
- Use [variable_name] format for all dynamic values
- Include ALL variables used in the "variables" array (excluding patient_name which is always included)
- Common variables: [practice_number], [street_address], [city], [state], [postal_code], [appointment_date], etc.

=== SMS SURVEY JSON FORMAT ===
If input is JSON with "pages" and "elements", parse it as an SMS survey:

CRITICAL - PRESERVE ORIGINAL WORDING:
- Keep the SMS text AS CLOSE TO ORIGINAL as possible
- Only make minimal changes needed for voice (remove URLs, "text X" → "say X")
- Do NOT rewrite or paraphrase the content
- Do NOT add new content or questions not in the original

CRITICAL - NO NUMBERS FOR OPTIONS:
- NEVER say "say 1" or "press 2" or "respond with the number"
- For binary choices (yes/no type): Phrase as a natural question
  Example: "Would you like information to schedule, or are you not interested?"
  The patient can naturally say "yes", "schedule", "not interested", etc.
- For multiple choices: Read the options naturally
  Example: "Please tell me why you're not interested. You can say: you're no longer a patient of the practice, you follow with a diabetes doctor, or it's not a priority right now."

ELEMENT MAPPING:
- "radiogroup" → type: "question" (multiple choice)
- "html" → type: "statement" (info display) OR "question" (if it presents choices like MAIL/CALL)
- "text" → type: "question" (ask verbally, the LLM will listen and respond naturally)

PARSING RULES:
1. Element "name" → step ID (snake_case)
2. Element "title" → Use the ORIGINAL title text, just remove "Text 1 for..." type instructions
3. Element "html" → Keep original text, just remove URLs and adapt "text X" to "say X"
4. Element "choices" → options with their original text as labels
5. "visibleIf" → determines branching ({Info}=1 means this step follows when Info was option 1)
6. Elements without visibleIf are entry points

VARIABLE CONVERSION:
- {{@practice_number}} → [practice_number]
- PARTICIPANT_STREET_ADDRESS → [street_address]
- PARTICIPANT_CITY → [city]
- PARTICIPANT_STATE → [state]
- PARTICIPANT_POSTAL_CODE → [postal_code]
- PARTICIPANT_STREET_ADDRESS_2 → [street_address_2]
- Any {{@var}} → [var]

BRANCHING:
- Parse visibleIf conditions to build flow tree
- Statement steps auto-continue to their next step
- Terminal branches go to "end_call"

VOICE ADAPTATION (MINIMAL CHANGES ONLY):
- Remove URLs (can't click in voice)
- Remove "Text 1 for X or 2 for Y" → Replace with natural question
- Replace "text MAIL" with "say mail"
- Keep ALL other original wording intact

=== OPEN PROMPT FORMAT ===
If input is NOT JSON, generate a complete script from the prompt.
This path is unchanged - create steps based on the topics in the prompt.

=== ACKNOWLEDGEMENTS (REQUIRED) ===
After EVERY patient response, include a brief acknowledgement before the next question:
- Positive: "Great.", "Good to hear.", "Perfect.", "Wonderful."
- Neutral: "Got it.", "Okay, thank you.", "I understand.", "Thanks for letting me know."
- Concerning: "I'm sorry to hear that.", "I understand, thank you for sharing."
- Callback-triggering: "I'll make sure someone from our care team calls you back."

Include these in the script instructions so the agent says them naturally.

=== FLOW RULES (ALL FORMATS) ===
1. Greeting: "Hi [patient_name], this is Penn Medicine calling..." + first question or statement
2. Use [placeholder] format for variables - add them to "variables" array
3. STEP ID = snake_case of label
4. Every "next" must reference an existing step ID or "end_call"
5. Statement steps: options = [{"label": "continue", "next": "next_step_id"}]
6. Questions asking for open-ended info (like new address): still type "question", LLM handles naturally
7. Terminal points (confirmations, etc.) go to "end_call"
8. Last spoken text must contain "goodbye"
9. final_phrases: ["goodbye", "take care", "bye"]
10. Include "keywords" array for each option with speech variations

=== EXAMPLE: SMS → IVR ===
SMS input:
{
  "type": "radiogroup",
  "name": "addresscheck",
  "title": "Is PARTICIPANT_STREET_ADDRESS your correct address?",
  "choices": [{"value": "Y", "text": "Yes"}, {"value": "N", "text": "No"}]
}

IVR output:
{
  "id": "address_check",
  "label": "Address Check", 
  "type": "question",
  "question": "The mailing address we have on file is [street_address], [city], [state], [postal_code]. Is this your correct address?",
  "options": [
    {"label": "Yes", "keywords": ["yes", "yeah", "correct", "right"], "next": "confirmation"},
    {"label": "No", "keywords": ["no", "nope", "wrong", "incorrect"], "next": "new_address"}
  ]
}

Variables: ["street_address", "city", "state", "postal_code"]

=== EXAMPLE: Text input → Question ===
SMS "text" element asking for new address becomes a regular question:
{
  "id": "new_address",
  "label": "New Address",
  "type": "question",
  "question": "What is your current mailing address?",
  "info": "Patient provides address verbally",
  "options": [
    {"label": "Address provided", "keywords": ["*"], "next": "confirmation"}
  ]
}
The LLM will listen to whatever they say and acknowledge it naturally.
`;
}

function buildUserMessage(script: string, inputType: string, mode: string): string {
  // Input type is determined by user button selection, not content detection
  if (inputType === 'script') {
    // SMS/IVR Script mode - parse as structured survey format
    return `INPUT TYPE: SMS Survey Script

Task: Convert this SMS/IVR survey script into a voice IVR script.

CRITICAL RULES:
1. PRESERVE ORIGINAL TEXT - Keep the exact wording from the SMS as much as possible
2. NO NUMBERS - Never say "say 1" or "press 2". Convert to natural language:
   - Binary: "Would you like to schedule, or are you not interested?"
   - Multiple: "You can say: [option 1], [option 2], or [option 3]"
3. MINIMAL CHANGES - Only adapt what's necessary for voice:
   - Remove URLs
   - Remove "Text 1 for..." instructions
   - Replace "text MAIL" with "say mail"

The questions and statements should sound almost identical to the SMS, just spoken naturally.

SMS/IVR Script to convert:
${script}
`;
  }

  // Open-ended prompt mode - generate from description
  return `INPUT TYPE: Open-ended prompt

Task: Generate a complete IVR voice script and flow from this description.
Create steps for each topic mentioned, include any variables in "variables" array.

IMPORTANT - Include acknowledgements after each patient response:
- Positive responses: "Great.", "Good to hear.", "Perfect."
- Neutral responses: "Got it.", "Okay, thank you.", "I understand."
- Concerning responses: "I'm sorry to hear that.", "Thank you for letting me know."

Remember: Penn Medicine greeting, [patient_name] placeholder, warm conversational tone, end with goodbye.

Prompt:
${script}
`;
}

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
    const { script, inputType } = req.body || {};

    if (!script || typeof script !== 'string') {
      return res.status(400).json({ error: 'Script text is required' });
    }

    // For SMS/script input, always use multi-step conversion.
    if (inputType === 'script') {
      return await handleMultiStepConversion(req, res, apiKey);
    }

    // Open-ended prompt generation: pass 1 (existing generation call)
    const systemInstructions = buildConversionInstructions();
    const userMessage = buildUserMessage(script, inputType);

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

    // Open-ended prompt generation: pass 2 (flow review/fix pass)
    parsed = await reviewOpenPromptFlowWithLLM(parsed, script, apiKey);

    if (parsed.flow?.steps && Array.isArray(parsed.flow.steps)) {
      const callbackNormalized = ensureCallbackRouting(parsed.flow);
      parsed.flow = callbackNormalized.flowMap;
      if (callbackNormalized.changed) {
        // Keep script text aligned with routing safeguards so prompt and flow map agree.
        parsed.script = buildScriptContentFromFlow(parsed.flow.steps);
        console.log(`[single] Added callback routing safeguards (${callbackNormalized.addedStepIds.length} callback step(s))`);
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

async function reviewOpenPromptFlowWithLLM(parsed: any, originalPrompt: string, apiKey: string): Promise<any> {
  try {
    const reviewInput = `You are a second-pass IVR flow reviewer.
Review and improve the generated IVR JSON for LOGICAL CONSISTENCY and NON-REDUNDANCY.

INPUT JSON:
${JSON.stringify(parsed, null, 2)}

ORIGINAL USER PROMPT (for intent context):
${originalPrompt}

REVIEW RULES:
1. Keep original clinical intent and tone; make minimal structural fixes only.
2. Fix logical issues: contradictory branches, dead ends, unreachable steps, loops, invalid next references.
3. Reduce redundancy: merge duplicate options/steps if they mean the same thing.
4. Keep one-step-at-a-time flow (no overstepping).
5. If an option means team should call patient back, route through a callback confirmation step before normal continuation.
6. Ensure every option.next points to an existing step id or "end_call".
7. Ensure a closing path exists and ends with goodbye.
8. Preserve placeholders/variables and keep the "variables" array aligned.
9. Combine related adjacent questions when reasonable:
   - If two consecutive questions are tightly related and can be asked naturally together, combine them into one clearer question.
   - Do NOT combine if it would make the question too long/confusing or if branching outcomes differ.
   - Keep patient experience concise and conversational.
10. Ensure option-level alert metadata exists where needed:
    - callback-style options should include alerts with type "callback"
    - reminder/follow-up promise options should include alerts with type "reminder"

Return ONLY valid JSON in the same schema as input:
{
  "greeting": string,
  "script": string,
  "final_phrases": [string],
  "variables": [string],
  "flow": { "title": string, "steps": [...] }
}`;

    const reviewResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.2',
        input: reviewInput,
        reasoning: { effort: 'medium' },
      }),
    });

    if (!reviewResponse.ok) {
      console.error('[open-prompt review] reviewer call failed:', await reviewResponse.text());
      return parsed;
    }

    const reviewData = await reviewResponse.json();
    const messageBlock = reviewData.output?.find((item: any) => item.type === 'message');
    const reviewContent = messageBlock?.content?.[0]?.text;
    if (!reviewContent) return parsed;

    let reviewed;
    try {
      reviewed = JSON.parse(reviewContent);
    } catch {
      const jsonMatch = reviewContent.match(/```(?:json)?\s*([\s\S]*?)```/) || reviewContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return parsed;
      reviewed = JSON.parse((jsonMatch[1] || jsonMatch[0]).trim());
    }

    if (!reviewed || typeof reviewed !== 'object') return parsed;
    return reviewed;
  } catch (error) {
    console.error('[open-prompt review] failed, using pass-1 result:', error);
    return parsed;
  }
}

// Multi-step conversion handler
async function handleMultiStepConversion(req: VercelRequest, res: VercelResponse, apiKey: string) {
  const { script } = req.body;

  try {
    console.log('[multi-step] Starting multi-step conversion...');
    
    // Step 1: Parse SMS JSON + context to extract structured elements
    const { elements: parsedElements, context } = parseSmsInput(script);
    console.log(`[multi-step] Step 1: Parsed ${parsedElements.length} elements from input${context ? ' (with context)' : ''}`);
    
    // Step 2: Build flow map using LLM (understands complex visibleIf logic + context)
    const llmFlowMap = await buildFlowWithLLM(parsedElements, apiKey, context);
    const callbackNormalized = ensureCallbackRouting(llmFlowMap);
    const flowMap = callbackNormalized.flowMap;
    console.log(`[multi-step] Step 2: Built flow with ${flowMap.steps.length} steps`);
    if (callbackNormalized.changed) {
      console.log(`[multi-step] Step 2b: Added callback routing safeguards (${callbackNormalized.addedStepIds.length} callback step(s))`);
    }
    // Debug: log each step's connections
    for (const step of flowMap.steps) {
      const optionsSummary = step.options?.map((o: any) => `"${o.label}" → ${o.next}`).join(', ') || 'none';
      console.log(`[multi-step]   ${step.id} (${step.type}): ${optionsSummary}`);
    }
    
    // Step 3: Adapt text for voice using LLM (preserves original wording)
    const adaptedTexts = await adaptTextWithLLM(parsedElements, apiKey, context);
    console.log(`[multi-step] Step 3: Adapted ${Object.keys(adaptedTexts).length} texts`);
    // Debug: log adapted text keys vs element names
    console.log(`[multi-step]   Element names: ${parsedElements.map(e => e.name).join(', ')}`);
    console.log(`[multi-step]   Adapted keys:  ${Object.keys(adaptedTexts).join(', ')}`);
    
    // Step 4: Assemble final result
    const result = assembleResult(flowMap, adaptedTexts, parsedElements);
    console.log('[multi-step] Step 4: Assembled final result');
    console.log(`[multi-step]   Greeting: "${result.greeting?.substring(0, 100)}..."`);
    console.log(`[multi-step]   Variables: ${JSON.stringify(result.variables)}`);
    console.log(`[multi-step]   Flow steps: ${result.flowMap?.steps?.length}`);
    // Check for [patient_name] in greeting
    console.log(`[multi-step]   Greeting has [patient_name]: ${result.greeting?.includes('[patient_name]')}`);
    
    return res.status(200).json(result);
  } catch (error) {
    console.error('[multi-step] Error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Multi-step conversion failed',
    });
  }
}

// Step 1: Parse input that may contain context text + one or more JSON blocks
function parseSmsInput(script: string): {
  elements: Array<{
    id: string;
    type: string;
    name: string;
    title?: string;
    html?: string;
    choices?: Array<{ value: string; text: string }>;
    visibleIf?: string;
    stepLabel?: string; // e.g., "Step 1", "Step 2"
  }>;
  context: string; // Non-JSON context text (program description, etc.)
} {
  const allElements: any[] = [];
  let context = '';

  // Try parsing as pure JSON first
  try {
    const json = JSON.parse(script.trim());
    const elements = json.pages?.[0]?.elements || [];
    return {
      elements: elements.map((el: any) => ({
        id: el.name,
        type: el.type,
        name: el.name,
        title: el.title,
        html: el.html,
        choices: el.choices,
        visibleIf: el.visibleIf,
      })),
      context: '',
    };
  } catch {
    // Not pure JSON - extract JSON blocks and context
  }

  // Extract all JSON blocks from the mixed input
  const jsonBlocks: { json: any; startIdx: number; endIdx: number; label: string }[] = [];
  let searchIdx = 0;
  
  while (searchIdx < script.length) {
    // Find next opening brace that starts a top-level JSON object
    const braceIdx = script.indexOf('{', searchIdx);
    if (braceIdx === -1) break;
    
    // Try to find the matching closing brace
    let depth = 0;
    let endIdx = -1;
    for (let i = braceIdx; i < script.length; i++) {
      if (script[i] === '{') depth++;
      else if (script[i] === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    
    if (endIdx === -1) {
      searchIdx = braceIdx + 1;
      continue;
    }
    
    const candidate = script.slice(braceIdx, endIdx + 1);
    try {
      const parsed = JSON.parse(candidate);
      // Check if it looks like a survey JSON (has pages/elements)
      if (parsed.pages || parsed.elements) {
        // Look for a step label before this JSON block (e.g., "Step 1:")
        const textBefore = script.slice(Math.max(0, braceIdx - 100), braceIdx);
        const stepMatch = textBefore.match(/(?:step\s*(\d+))[:\s]*$/i);
        const label = stepMatch ? `Step ${stepMatch[1]}` : '';
        
        jsonBlocks.push({ json: parsed, startIdx: braceIdx, endIdx, label });
      }
      searchIdx = endIdx + 1;
    } catch {
      searchIdx = braceIdx + 1;
    }
  }

  if (jsonBlocks.length === 0) {
    throw new Error('No valid SMS JSON blocks found in input. Expected JSON with "pages" and "elements".');
  }

  // Extract context: everything that isn't inside a JSON block
  let lastEnd = 0;
  const contextParts: string[] = [];
  for (const block of jsonBlocks) {
    const before = script.slice(lastEnd, block.startIdx).trim();
    if (before) contextParts.push(before);
    lastEnd = block.endIdx + 1;
  }
  const trailing = script.slice(lastEnd).trim();
  if (trailing) contextParts.push(trailing);
  context = contextParts.join('\n').trim();

  // Extract elements from all JSON blocks
  for (const block of jsonBlocks) {
    const elements = block.json.pages?.[0]?.elements || block.json.elements || [];
    for (const el of elements) {
      allElements.push({
        id: el.name,
        type: el.type,
        name: el.name,
        title: el.title,
        html: el.html,
        choices: el.choices,
        visibleIf: el.visibleIf,
        stepLabel: block.label,
      });
    }
  }

  if (allElements.length === 0) {
    throw new Error('No elements found in JSON blocks.');
  }

  console.log(`[multi-step] Extracted ${allElements.length} elements from ${jsonBlocks.length} JSON block(s), context: ${context.length} chars`);

  return { elements: allElements, context };
}

// Step 2: Build flow map using LLM
async function buildFlowWithLLM(elements: any[], apiKey: string, context: string = ''): Promise<any> {
  const contextSection = context 
    ? `\nPROGRAM CONTEXT (provided by user - use this to understand the purpose and flow):\n${context}\n` 
    : '';

  const prompt = `You are a flow map builder. Given SMS survey elements, create a flow map showing how they connect.
${contextSection}
ELEMENTS:
${elements.map((el, idx) => `
Element ${idx + 1}: ${el.name} (${el.type})${el.stepLabel ? ` [${el.stepLabel}]` : ''}
${el.title ? `Title: "${el.title}"` : ''}
${el.html ? `HTML: "${el.html}"` : ''}
${el.choices ? `Choices: ${el.choices.map((c: any) => `${c.value}="${c.text}"`).join(', ')}` : ''}
${el.visibleIf ? `Visible if: ${el.visibleIf}` : 'Entry point (no condition)'}
`).join('\n')}

TASK: Create a flow map JSON showing:
1. Parse visibleIf conditions (e.g., "{Info}=1" means shown when Info choice value was "1")
2. Map which options lead to which next steps based on visibleIf references
3. Identify entry points (no visibleIf) and terminals (no outgoing links)
4. If there are multiple JSON blocks (e.g., Step 1, Step 2), connect them - the last element of Step 1 that links to Step 2 should flow into Step 2's first element
5. For "html" type elements:
   - If the text contains embedded choices or asks the user to respond (e.g., "say mail", "say call", "text MAIL or CALL"), make it type "question" with those as options - the patient needs to respond
   - If the text is purely informational with no choices (e.g., "Thanks for letting us know. We will update our records."), make it type "statement" with a single option: {"label": "continue", "next": "next_step_id"}
   - IMPORTANT: Read the text carefully. If there's ANY prompt for the user to choose or respond, it must be a "question", not a "statement"
6. For "text" type elements (free-text input), make them type "question" - the patient will answer freely
7. ALWAYS include a "closing" step at the end with type "statement", question: "Thank you for your time. Take care, goodbye!" and options: [{"label": "end", "next": "end_call"}]
8. The closing step must NOT contain any SMS-specific text like "Reply STOP to opt out" - this is a voice call, not SMS
9. CALLBACK ROUTING RULE: if any option means the team will call the patient (callback intent), do NOT route directly to closing. Route to an explicit callback confirmation statement first (e.g., "I'll make sure someone from our team calls you back"), then continue to the normal next step.
10. Add option-level alerts when appropriate (to avoid hardcoded alerts in app):
   - Callback intent options: add alert {type: "callback", reason, action}
   - Reminder/follow-up promise options: add alert {type: "reminder", reason, action}
   - Only add alerts for options that represent actual operational follow-up actions

Return ONLY valid JSON:
{
  "title": "Flow name",
  "steps": [
    {
      "id": "step_id (snake_case of element name)",
      "label": "Human readable label",
      "type": "question or statement",
      "question": "The text content from the element",
      "info": "",
      "options": [
        {
          "label": "Option text",
          "keywords": ["keyword1", "keyword2"],
          "next": "next_step_id or end_call",
          "triggers_callback": boolean,
          "alerts": [{"type": "callback or reminder", "reason": "why this alert should fire", "action": "what staff should do"}]
        }
      ]
    }
  ]
}

CRITICAL: 
- Ensure all "next" values point to valid step IDs or "end_call"
- Terminal steps should lead to a closing step, and closing leads to "end_call"
- Entry points come first in the flow
- Include ALL elements from ALL JSON blocks in the flow
- step ID = snake_case of the element name`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.2',
      input: prompt,
      reasoning: { effort: 'medium' }
    }),
  });

  if (!response.ok) {
    throw new Error('Flow building failed');
  }

  const data = await response.json();
  const messageBlock = data.output?.find((item: any) => item.type === 'message');
  const content = messageBlock?.content?.[0]?.text;
  
  if (!content) {
    throw new Error('No flow map generated');
  }

  // Parse JSON from response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No valid JSON in flow map response');
  }

  return JSON.parse(jsonMatch[0]);
}

function hasCallbackIntent(text: string): boolean {
  const lower = (text || '').toLowerCase();
  if (!lower) return false;

  // Positive signals that the patient is asking to be called by the care team.
  const callbackSignals = [
    /\bcall me\b/,
    /\bcall(?:\s+us)? back\b/,
    /\bcallback\b/,
    /\breturn(?:\s+a)? call\b/,
    /\bsomeone(?:\s+from(?:\s+the)?\s+team)?\s+call\b/,
    /\bteam\s+call\b/,
    /\bhave someone call\b/,
  ];

  // Exclude intents where the patient says THEY will place the call.
  const selfCallSignals = [
    /\bi\s+will\s+call\b/,
    /\bi'll\s+call\b/,
    /\bcall\s+the\s+lab\b/,
    /\bcall\s+penn\b/,
    /\bcall\s+your\s+doctor\b/,
  ];

  const isCallback = callbackSignals.some((re) => re.test(lower));
  if (!isCallback) return false;
  if (selfCallSignals.some((re) => re.test(lower))) return false;
  return true;
}

function isCallbackStep(step: any): boolean {
  const combined = `${step?.label || ''} ${step?.info || ''} ${step?.question || ''}`.toLowerCase();
  return (
    combined.includes('call you back') ||
    combined.includes('callback') ||
    combined.includes('someone from our team calls you') ||
    combined.includes('someone will call you')
  );
}

function buildScriptContentFromFlow(steps: any[]): string {
  return steps.map((step: any) => {
    const isStatement = step.type === 'statement';
    const typeTag = isStatement
      ? ' [STATEMENT - auto-continue, do NOT wait for response]'
      : ' [QUESTION - wait for patient response]';

    let optionsText: string;
    if (isStatement) {
      const nextStep = step.options?.[0]?.next || 'end_call';
      optionsText = `→ Then IMMEDIATELY continue to: ${nextStep}`;
    } else {
      optionsText = step.options?.map((opt: any) =>
        `- If patient says "${opt.label}": go to ${opt.next}${opt.triggers_callback ? ' (callback)' : ''}`
      ).join('\n') || '';
    }

    return `STEP ${step.id} - ${step.label}${typeTag}:\n"${step.question}"\n${optionsText}\n`;
  }).join('\n');
}

function ensureCallbackRouting(flowMap: any): { flowMap: any; changed: boolean; addedStepIds: string[] } {
  if (!flowMap?.steps || !Array.isArray(flowMap.steps)) {
    return { flowMap, changed: false, addedStepIds: [] };
  }

  const steps = flowMap.steps.map((step: any) => ({
    ...step,
    options: Array.isArray(step.options) ? step.options.map((o: any) => ({ ...o })) : [],
  }));

  const stepById = new Map<string, any>(steps.map((s: any) => [s.id, s]));
  const existingIds = new Set<string>(steps.map((s: any) => s.id));
  const addedSteps: any[] = [];
  const addedStepIds: string[] = [];
  let changed = false;

  const makeUniqueId = (base: string): string => {
    let id = base;
    let i = 2;
    while (existingIds.has(id)) {
      id = `${base}_${i}`;
      i++;
    }
    existingIds.add(id);
    return id;
  };

  for (const step of steps) {
    if (!Array.isArray(step.options) || step.options.length === 0) continue;

    step.options = step.options.map((opt: any, idx: number) => {
      const label = String(opt?.label || '');
      const needsCallback = opt?.triggers_callback === true || hasCallbackIntent(label);
      if (!needsCallback) return opt;

      const nextStepId = String(opt?.next || '').trim();
      const nextStep = nextStepId ? stepById.get(nextStepId) : null;

      // Already routed via callback confirmation step.
      if (nextStep && isCallbackStep(nextStep)) {
        if (!opt.triggers_callback) changed = true;
        const existingAlerts = Array.isArray(opt.alerts) ? opt.alerts : [];
        const hasCallbackAlert = existingAlerts.some((a: any) => a?.type === 'callback');
        return {
          ...opt,
          triggers_callback: true,
          alerts: hasCallbackAlert
            ? existingAlerts
            : [...existingAlerts, {
                type: 'callback',
                reason: 'Patient requested a callback from the care team',
                action: 'Review transcript and schedule callback within 24 hours',
              }],
        };
      }

      const callbackStepId = makeUniqueId(`callback_${step.id}_${idx + 1}`);
      const continueTo = nextStepId || 'end_call';

      addedSteps.push({
        id: callbackStepId,
        label: 'Callback confirmation',
        type: 'statement',
        info: 'Confirms team will call patient back',
        question: "I understand. We'll have someone from our care team call you back.",
        options: [{ label: 'continue', next: continueTo }],
      });
      addedStepIds.push(callbackStepId);
      changed = true;

      return {
        ...opt,
        triggers_callback: true,
        next: callbackStepId,
        alerts: [
          ...((Array.isArray(opt.alerts) ? opt.alerts : []).filter((a: any) => a?.type !== 'callback')),
          {
            type: 'callback',
            reason: 'Patient requested a callback from the care team',
            action: 'Review transcript and schedule callback within 24 hours',
          },
        ],
      };
    });
  }

  if (addedSteps.length === 0) {
    return { flowMap: { ...flowMap, steps }, changed: false, addedStepIds: [] };
  }

  const closingIdx = steps.findIndex((s: any) =>
    s.id === 'closing' ||
    String(s.label || '').toLowerCase().includes('closing') ||
    String(s.label || '').toLowerCase().includes('goodbye')
  );

  const mergedSteps = [...steps];
  if (closingIdx >= 0) {
    mergedSteps.splice(closingIdx, 0, ...addedSteps);
  } else {
    mergedSteps.push(...addedSteps);
  }

  return {
    flowMap: { ...flowMap, steps: mergedSteps },
    changed,
    addedStepIds,
  };
}

// Step 3: Adapt text for voice using LLM
async function adaptTextWithLLM(elements: any[], apiKey: string, context: string = ''): Promise<Record<string, string>> {
  const textsToAdapt = elements.map((el, idx) => `
${idx + 1}. ${el.name}${el.stepLabel ? ` [${el.stepLabel}]` : ''}:
Type: ${el.type}
${el.title ? `Text: "${el.title}"` : ''}
${el.html ? `Text: "${el.html}"` : ''}
${el.choices ? `Options: ${el.choices.map((c: any) => c.text).join(', ')}` : ''}`).join('\n');

  const contextSection = context 
    ? `\nPROGRAM CONTEXT:\n${context}\n` 
    : '';

  const prompt = `You adapt SMS text for voice calls. Keep original wording, just make minimal changes for voice.
${contextSection}
TEXTS TO ADAPT:
${textsToAdapt}

RULES:
1. PRESERVE ORIGINAL WORDING - Keep text almost identical, just:
   - Remove URLs (https://...)
   - Remove "Text 1 for X" / "Respond with the NUMBER ONLY" instructions
   - Replace "text MAIL" with "say mail"
   - Replace "text Y for Yes or N for No" with natural questions
2. REMOVE SMS-SPECIFIC PHRASES - Remove things that don't make sense on a phone call:
   - Remove "Reply STOP to opt out of messages" or similar opt-out SMS text
   - Remove "text us" → replace with "tell us" or "let us know"
   - Remove any reference to texting, SMS, messaging
3. NO NUMBERS - Convert number-based choices to natural language. Read options conversationally.
4. GREETING - ALWAYS include [patient_name] in the first element/greeting:
   - If text has greeting: integrate naturally (e.g., "Hello [patient_name], this is Penn Medicine...")
   - If no greeting: start with "Hi [patient_name], ..."
   - NEVER duplicate greetings
5. ACKNOWLEDGMENTS - Only add acknowledgments to elements that FOLLOW a patient response (i.e., elements triggered by a user choice via visibleIf). Do NOT add acknowledgments to elements that auto-continue from a statement.
   - Use brief phrases: "Got it.", "I understand.", "Thank you.", "Thanks for letting us know."
   - Do NOT add duplicate acknowledgments - if the next step already starts with an acknowledgment, don't prepend another one
6. VARIABLES - Replace ALL_CAPS variables with [lowercase_snake_case] placeholders:
   - PARTICIPANT_STREET_ADDRESS → [street_address]
   - PARTICIPANT_CITY → [city]
   - {{@practice_number}} → [practice_number]
7. Use warm, conversational language throughout

Return ONLY valid JSON mapping element names to adapted text:
{
  "element_name_1": "Adapted text for voice...",
  "element_name_2": "Adapted text for voice...",
  ...
}`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.2',
      input: prompt,
      reasoning: { effort: 'medium' }
    }),
  });

  if (!response.ok) {
    throw new Error('Text adaptation failed');
  }

  const data = await response.json();
  const messageBlock = data.output?.find((item: any) => item.type === 'message');
  const content = messageBlock?.content?.[0]?.text;
  
  if (!content) {
    throw new Error('No adapted texts generated');
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No valid JSON in adapted texts response');
  }

  return JSON.parse(jsonMatch[0]);
}

// Step 4: Assemble final result
function assembleResult(flowMap: any, adaptedTexts: Record<string, string>, elements: any[]): any {
  // Build a lookup: try step.id, then original element name, then case-insensitive match
  const findAdaptedText = (stepId: string): string | null => {
    if (adaptedTexts[stepId]) return adaptedTexts[stepId];
    // Try finding by original element name (adaptedTexts keys are element names from the LLM)
    const lowerStepId = stepId.toLowerCase();
    for (const [key, value] of Object.entries(adaptedTexts)) {
      if (key.toLowerCase() === lowerStepId) return value;
      // Also try matching snake_case step id to camelCase/PascalCase element name
      const keySnake = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      if (keySnake === lowerStepId) return value;
    }
    return null;
  };

  // Update flow map steps with adapted text
  const updatedSteps = flowMap.steps.map((step: any) => {
    const adaptedText = findAdaptedText(step.id);
    return {
      ...step,
      question: adaptedText || step.question,
    };
  });

  // Detect greeting (first element's adapted text if it's an entry point)
  const firstElement = elements.find(el => !el.visibleIf);
  let greeting = firstElement 
    ? (adaptedTexts[firstElement.name] || adaptedTexts[firstElement.id] || 'Hello [patient_name], this is Penn Medicine calling.') 
    : 'Hello [patient_name], this is Penn Medicine calling.';
  
  // Ensure greeting has [patient_name] - if the LLM didn't include it, prepend it
  if (!greeting.toLowerCase().includes('[patient_name]')) {
    greeting = `Hello [patient_name], ` + greeting.charAt(0).toLowerCase() + greeting.slice(1);
    console.log('[multi-step] Greeting was missing [patient_name], prepended it');
  }

  // Extract variables from all adapted texts + step questions + greeting
  // Regex includes digits to catch names like [street_address_2]
  const variables = new Set<string>();
  const allTexts = [...Object.values(adaptedTexts), ...updatedSteps.map((s: any) => s.question), greeting];
  allTexts.forEach(text => {
    if (typeof text !== 'string') return;
    const matches = text.match(/\[([a-z0-9_]+)\]/g);
    if (matches) {
      matches.forEach(match => {
        const varName = match.slice(1, -1);
        variables.add(varName);
      });
    }
  });

  // Clean up closing step - remove SMS-specific phrases
  for (const step of updatedSteps) {
    if (step.id === 'closing' || step.label?.toLowerCase().includes('closing') || step.label?.toLowerCase().includes('goodbye')) {
      if (step.question) {
        // Remove "Reply STOP to opt out of messages" and similar SMS text
        step.question = step.question
          .replace(/\.?\s*Reply STOP to opt out of messages\.?/gi, '')
          .replace(/\.?\s*Text STOP to opt out\.?/gi, '')
          .replace(/\.?\s*Reply STOP.*$/gi, '')
          .trim();
        // If closing is now empty or too short, give a default
        if (!step.question || step.question.length < 10) {
          step.question = 'Thank you for your time. Take care, goodbye!';
        }
        // Make sure closing ends with goodbye if it doesn't
        if (!step.question.toLowerCase().includes('goodbye') && !step.question.toLowerCase().includes('bye')) {
          step.question += ' Goodbye.';
        }
      }
    }
  }

  // Build script content - clearly mark statement vs question steps
  const scriptContent = buildScriptContentFromFlow(updatedSteps);

  return {
    greeting,
    scriptContent,
    finalPhrases: ['goodbye', 'bye', 'take care'],
    flowMap: { ...flowMap, steps: updatedSteps },
    variables: Array.from(variables),
  };
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
          {
            "label": string,
            "keywords": [string],
            "next": string,
            "triggers_callback": boolean,
            "alerts": [{"type": "callback" | "reminder", "reason": string, "action": string}]
          }
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
- Include ALL variables used in the "variables" array (including [patient_name])
- Common variables: [patient_name], [practice_number], [street_address], [city], [state], [postal_code], [appointment_date], etc.

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
- Remove SMS-specific phrases that don't make sense on a voice call:
  - Remove "Reply STOP to opt out of messages" or similar opt-out text
  - Replace "text us" with "tell us" or "let us know"
  - Remove any reference to texting, SMS, or messaging
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
1. GREETING: 
   - ALWAYS include [patient_name] in the greeting
   - If SMS has a greeting: integrate [patient_name] naturally (e.g., "Hello [patient_name], this is Penn Medicine...")
   - If SMS has no greeting: start with "Hi [patient_name], this is Penn Medicine calling..."
   - NEVER duplicate greetings
   - The greeting should flow naturally into the first question
2. Use [placeholder] format for variables - add them to "variables" array
3. STEP ID = snake_case of label
4. Every "next" must reference an existing step ID or "end_call"
5. Statement steps: options = [{"label": "continue", "next": "next_step_id"}]
6. Questions asking for open-ended info (like new address): still type "question", LLM handles naturally
7. Terminal points (confirmations, etc.) go to "end_call"
8. Last spoken text must contain "goodbye"
9. final_phrases: ["goodbye", "take care", "bye"]
10. Include "keywords" array for each option with speech variations
11. CALLBACK ROUTING: If an option means the team will call the patient, route to an explicit callback confirmation step first (statement), then continue to the normal next step. Do NOT route callback-intent options directly to closing.
12. COMBINE RELATED QUESTIONS WHEN REASONABLE:
    - If adjacent questions are clearly related and can be asked naturally together, combine them into one concise question.
    - Do NOT combine unrelated topics or steps with different branching outcomes.
    - Prefer fewer, clearer questions when it improves flow.
13. OPTION ALERT METADATA:
    - Add alerts on options when they imply operational follow-up.
    - Callback-style options → alerts include {type:"callback", reason, action}
    - Reminder/follow-up promise options → alerts include {type:"reminder", reason, action}

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

function buildUserMessage(script: string, inputType: string): string {
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
4. REMOVE SMS-SPECIFIC PHRASES:
   - Remove "Reply STOP to opt out of messages" or similar opt-out text
   - Replace "text us" with "tell us" or "let us know"  
   - Remove any reference to texting, SMS, or messaging
5. GREETING WITH [patient_name]:
   - ALWAYS include [patient_name] in the greeting
   - If SMS has greeting: integrate naturally (e.g., "Hello [patient_name], this is Penn Medicine...")
   - If SMS has no greeting: start with "Hi [patient_name], this is Penn Medicine calling..."
   - NEVER duplicate greetings
6. CALLBACK ROUTING:
   - If an option means the team should call the patient, route to an explicit callback confirmation step first
   - Do NOT route callback-intent options straight to closing

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

GREETING: ALWAYS include [patient_name] in the greeting. Start with "Hi [patient_name], this is Penn Medicine calling..."

Remember: Warm conversational tone, end with goodbye.

Prompt:
${script}
`;
}

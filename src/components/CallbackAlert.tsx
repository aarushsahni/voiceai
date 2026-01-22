import { AlertTriangle, Phone, CheckCircle } from 'lucide-react';

interface CallbackAlertProps {
  needsCallback: boolean;
  reasons: string[];
  callEnded: boolean;
}

export function CallbackAlert({ needsCallback, reasons, callEnded }: CallbackAlertProps) {
  if (!needsCallback) {
    // Show positive indicator if call ended with no concerns
    if (callEnded) {
      return (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-6 h-6 text-green-600" />
            <div>
              <h3 className="font-semibold text-green-800">No Follow-Up Required</h3>
              <p className="text-sm text-green-700">
                Patient reported feeling as expected with no concerns.
              </p>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="bg-amber-50 border-2 border-amber-400 rounded-lg p-4 animate-pulse">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          <AlertTriangle className="w-7 h-7 text-amber-600" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-amber-800 text-lg">
              CALLBACK REQUIRED
            </h3>
            <Phone className="w-5 h-5 text-amber-700" />
          </div>
          <p className="text-amber-800 mt-1">
            Patient expressed concern(s) - clinical team should follow up.
          </p>
          {reasons.length > 0 && (
            <div className="mt-2">
              <p className="text-sm font-medium text-amber-700">Reasons flagged:</p>
              <ul className="mt-1 list-disc list-inside text-sm text-amber-800">
                {reasons.map((reason, idx) => (
                  <li key={idx}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-3 p-2 bg-amber-100 rounded border border-amber-300">
            <p className="text-xs text-amber-800 font-medium">
              ACTION: Review transcript and schedule callback within 24 hours
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// Phrases the ASSISTANT says that indicate a callback is needed
// These are the actual acknowledgments from the IVR script
export const ASSISTANT_CALLBACK_PHRASES = [
  // English
  "we'll have someone from our care team call you back",
  "someone will call you back",
  "care team will call",
  "team will follow up",
  "we'll have someone call you",
  "i'll make sure the care team knows",
  // Spanish
  "alguien de nuestro equipo de atención le devolverá la llamada",
  "alguien le devolverá la llamada",
  "equipo de atención le llamará",
];

// Check if ASSISTANT text indicates a callback is scheduled
export function checkAssistantForCallback(assistantText: string): { needed: boolean; reason: string | null } {
  const lower = assistantText.toLowerCase();
  
  for (const phrase of ASSISTANT_CALLBACK_PHRASES) {
    if (lower.includes(phrase)) {
      return { 
        needed: true, 
        reason: 'Agent confirmed clinical team will call back' 
      };
    }
  }
  
  return { needed: false, reason: null };
}

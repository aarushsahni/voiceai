import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal .env.local loader (no dependency on dotenv).
 * Loads KEY=VALUE pairs into process.env without overwriting existing values.
 */
export function loadEnv(file = '.env.local'): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch {
    return; // file optional — key may already be in the shell env
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function requireApiKey(): string {
  loadEnv();
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error(
      '\n❌ OPENAI_API_KEY not found.\n' +
        '   Add it to .env.local (OPENAI_API_KEY=sk-...) or export it in your shell.\n',
    );
    process.exit(1);
  }
  return key;
}

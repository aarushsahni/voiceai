import type { VercelRequest, VercelResponse } from '@vercel/node';

type Handler = (req: VercelRequest, res: VercelResponse) => unknown | Promise<unknown>;

export interface HandlerResult {
  status: number;
  body: any;
}

/**
 * Invoke a Vercel serverless handler in-process with a mocked req/res.
 * This runs the EXACT production handler code path (api/match.ts, api/summary.ts,
 * api/generate.ts) without needing `vercel dev` or an HTTP server.
 */
export async function invokeHandler(
  handler: Handler,
  body: unknown,
  method = 'POST',
  opts: { silent?: boolean } = {},
): Promise<HandlerResult> {
  const { silent = true } = opts;
  let statusCode = 200;
  let jsonBody: any = undefined;
  let resolveDone: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  // Handlers are chatty (and log patient text). Mute their console during tests
  // unless explicitly asked to keep it.
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  if (silent) {
    console.log = console.info = console.warn = console.error = () => {};
  }

  const req = { method, body, headers: {}, query: {} } as unknown as VercelRequest;

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(obj: any) {
      jsonBody = obj;
      resolveDone();
      return this;
    },
    send(obj: any) {
      jsonBody = obj;
      resolveDone();
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      resolveDone();
      return this;
    },
  } as unknown as VercelResponse;

  try {
    await Promise.resolve(handler(req, res));
    // Most handlers call res.json synchronously after their await chain, but guard anyway.
    await Promise.race([done, new Promise((r) => setTimeout(r, 0))]);
  } finally {
    if (silent) Object.assign(console, saved);
  }

  return { status: statusCode, body: jsonBody };
}

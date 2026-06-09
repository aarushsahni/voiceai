import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { loadEnv } from '../lib/env';

/**
 * Minimal local server for the E2E harness:
 *   - serves the built SPA from dist/
 *   - routes /api/<name> to the real Vercel handler in api/<name>.ts
 *
 * This lets Playwright drive the actual app + real API code path without `vercel dev`.
 * Run `npm run build` first so dist/ exists.
 */

const DIST = resolve(process.cwd(), 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolveBody) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolveBody(data ? JSON.parse(data) : {});
      } catch {
        resolveBody({});
      }
    });
  });
}

async function handleApi(name: string, req: IncomingMessage, res: ServerResponse, query: Record<string, string>) {
  const handlerPath = resolve(process.cwd(), 'api', `${name}.ts`);
  if (!existsSync(handlerPath)) {
    res.writeHead(404).end(JSON.stringify({ error: `No api/${name}` }));
    return;
  }
  const mod = await import(handlerPath);
  const handler = mod.default;

  // Augment the REAL req/res with Vercel-style helpers. We pass the real objects
  // through (not a mock) so streaming handlers (SSE) can res.write() over time and
  // req.on('close') works.
  const r = req as any;
  r.query = query;
  r.body = req.method && !['GET', 'HEAD'].includes(req.method) ? await readBody(req) : {};

  const s = res as any;
  let status = 200;
  s.status = (code: number) => { status = code; return s; };
  s.json = (obj: any) => { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); return s; };
  s.send = (obj: any) => { if (!res.headersSent) res.writeHead(status); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); return s; };

  try {
    await handler(req, res);
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

async function serveStatic(pathname: string, res: ServerResponse) {
  let filePath = join(DIST, pathname === '/' ? 'index.html' : pathname);
  if (!existsSync(filePath)) filePath = join(DIST, 'index.html'); // SPA fallback
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

export function startServer(port = 4321): Promise<{ url: string; close: () => Promise<void> }> {
  loadEnv();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    if (url.pathname.startsWith('/api/')) {
      const query = Object.fromEntries(url.searchParams.entries());
      await handleApi(url.pathname.slice('/api/'.length), req, res, query);
    } else if (url.pathname.startsWith('/__clip/')) {
      // E2E patient audio clips injected as the fake mic (see runE2E.ts)
      const idx = url.pathname.slice('/__clip/'.length).replace(/\D/g, '');
      const clipPath = resolve(process.cwd(), 'sim/e2e/clips', `${idx}.wav`);
      if (existsSync(clipPath)) {
        res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(await readFile(clipPath));
      } else {
        res.writeHead(404).end('no clip');
      }
    } else {
      await serveStatic(url.pathname, res);
    }
  });

  return new Promise((resolveStart) => {
    server.listen(port, () => {
      resolveStart({
        url: `http://localhost:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(DIST)) {
    console.error('❌ dist/ not found. Run `npm run build` first.');
    process.exit(1);
  }
  startServer().then(({ url }) => console.log(`E2E server on ${url}`));
}

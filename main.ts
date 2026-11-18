/**
 * The forge entrypoint: `node main.ts` (Node 22 runs TypeScript directly).
 *
 * - Builds the in-memory store and registers the four surfaces (REST v3,
 *   git smart HTTP, GraphQL, MCP) plus /healthz.
 * - Binds an ephemeral port (listen(0)) and, when MAKEFUN_ENV_URL is set,
 *   registers that port with the environment, then polls /done until the
 *   trial finishes and exits 0.
 * - Without MAKEFUN_ENV_URL (local development) it serves on FORGE_PORT
 *   (default 3000) until stopped.
 */

import { ForgeStore } from './src/store.ts';
import { createForgeServer, route, type ForgeContext } from './src/server.ts';
import { initNow } from './src/util.ts';
import { registerRestRoutes } from './src/rest.ts';
import { registerGitRoutes } from './src/git.ts';
import { registerGraphqlRoutes } from './src/graphql.ts';
import { registerMcpRoutes } from './src/mcp.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Register this port with the environment, retrying while it comes up. */
async function register(envUrl: string, port: number): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}/register`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.ok) return;
      if (res.status === 409) throw new Error('another entry already registered');
      lastError = new Error(`register returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  throw lastError instanceof Error ? lastError : new Error('register failed');
}

/** Poll /done until the environment reports the trial is over. */
async function waitForDone(envUrl: string): Promise<void> {
  const url = `${envUrl.replace(/\/$/, '')}/done`;
  for (;;) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) {
        const body = (await res.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // The environment may restart or drop a long poll; keep polling.
    } finally {
      clearTimeout(timeout);
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  initNow(process.env.MAKEFUN_TRIAL_NOW);
  const store = new ForgeStore();
  const ctx: ForgeContext = { store, token: TOKEN, port: 0 };

  route('GET', '/healthz', (_req, res) => {
    res.json(200, { status: 'ok' });
  });
  registerRestRoutes();
  registerGitRoutes();
  registerGraphqlRoutes();
  registerMcpRoutes();

  const server = createForgeServer(ctx);
  const devPort = Number.parseInt(process.env.FORGE_PORT ?? '', 10);
  const listenPort = ENV_URL === '' && Number.isFinite(devPort) && devPort > 0 ? devPort : 0;
  await new Promise<void>((resolve) => {
    server.listen(listenPort, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : listenPort;
  ctx.port = port;

  if (ENV_URL === '') {
    console.log(`forge listening on http://127.0.0.1:${port} (dev mode, no MAKEFUN_ENV_URL)`);
    return;
  }

  await register(ENV_URL, port);
  console.log(`forge registered on port ${port}`);
  await waitForDone(ENV_URL);
  console.log('forge done');
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.exit(0);
}

main().catch((err) => {
  console.error('forge failed to start:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

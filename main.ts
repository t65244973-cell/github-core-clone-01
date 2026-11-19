// Entry point: start the forge on an ephemeral port, register that port with
// the suite, then poll the suite's /done endpoint until the run ends. Exits 1
// when MAKEFUN_ENV_URL is not set, exactly as the kit starter does. No UI, no
// outside service, one process, the store in memory.

import { Forge } from './store.ts';
import { createApp } from './app.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const envUrlRaw = process.env.MAKEFUN_ENV_URL;
  if (envUrlRaw === undefined || envUrlRaw === '') {
    console.error('[entry] MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }
  const envUrl = envUrlRaw.replace(/\/+$/, '');
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';

  const forge = new Forge();
  const server = createApp(forge, token);
  server.on('error', (error: Error) => {
    console.error(`[entry] server error: ${error.message}`);
    process.exit(1);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) {
    console.error('[entry] could not bind a port');
    process.exit(1);
  }

  let registered = false;
  for (let attempt = 0; attempt < 30 && !registered; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) {
        registered = true;
      } else {
        console.error(`[entry] register failed: HTTP ${response.status}`);
        await sleep(500);
      }
    } catch (error) {
      console.error(`[entry] register error: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(500);
    }
  }
  if (!registered) {
    console.error('[entry] could not register with the suite');
    process.exit(1);
  }

  for (;;) {
    await sleep(250);
    try {
      const response = await fetch(`${envUrl}/done`);
      if (!response.ok) continue;
      const data = (await response.json()) as { done?: boolean };
      if (data.done === true) break;
    } catch {
      // The suite endpoint is briefly unavailable; keep polling.
    }
  }

  server.close();
  process.exit(0);
}

await main();

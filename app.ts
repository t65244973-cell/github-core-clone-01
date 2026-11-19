// The forge's HTTP server: one process, one store, four surfaces.
// Routing: /healthz, git smart HTTP (/{owner}/{repo}.git/...), /api/graphql,
// /mcp, /api/v3/*. Every unknown route and every malformed git body answers
// JSON, never HTML, and the server stays up.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER_LOGIN } from './store.ts';
import { bearerToken, nextRequestId, sendError, sendJson, sendRaw, type Ctx } from './util.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  applyPush,
  decodePktLines,
  fetchResponse,
  lsRefsResponse,
  parseFetch,
  parseLsRefs,
  parsePush,
  pktLinesText,
  pushReportResponse,
  readPack,
  v0ReceiveAdvertisement,
  v2Advertisement,
  type Packet,
} from './git.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function gitRepo(ctx: Ctx, owner: string, repoName: string): import('./store.ts').Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.forge.getRepo(owner, repoName) ?? null;
}

async function handleGitPaths(ctx: Ctx, res: ServerResponse, pathname: string): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1]);
  const repoName = decodeURIComponent(match[2]);
  const action = match[3];
  const repo = gitRepo(ctx, owner, repoName);

  if (action === 'info/refs') {
    if (ctx.method !== 'GET') {
      sendError(res, 405, 'Method Not Allowed');
      return true;
    }
    const service = ctx.query.get('service');
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (service === 'git-upload-pack') {
      sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', v0ReceiveAdvertisement(repo));
      return true;
    }
    sendError(res, 400, 'Unknown service');
    return true;
  }

  if (action === 'git-upload-pack') {
    if (ctx.method !== 'POST') {
      sendError(res, 405, 'Method Not Allowed');
      return true;
    }
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    try {
      const { packets } = decodePktLines(ctx.body);
      const lines = pktLinesText(packets);
      const commandLine = lines.find((line) => line.startsWith('command='));
      const command = commandLine === undefined ? '' : commandLine.slice('command='.length).trim();
      if (command === 'ls-refs') {
        sendRaw(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, parseLsRefs(packets)));
        return true;
      }
      if (command === 'fetch') {
        sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchResponse(repo, parseFetch(packets)));
        return true;
      }
      sendError(res, 400, `Unknown command: ${command}`);
      return true;
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Bad request');
      return true;
    }
  }

  if (action === 'git-receive-pack') {
    if (ctx.method !== 'POST') {
      sendError(res, 405, 'Method Not Allowed');
      return true;
    }
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    try {
      const { commands, pack } = parsePush(ctx.body);
      let packObjects = new Map<string, import('./store.ts').GitObject>();
      if (pack !== null && pack.length > 0) {
        const read = readPack(pack, (oid) => repo.objects.get(oid));
        packObjects = read.objects;
      }
      const { unpackOk, unpackDetail, reports } = applyPush(repo, commands, packObjects);
      sendRaw(res, 200, 'application/x-git-receive-pack-result', pushReportResponse(unpackOk, unpackDetail, reports));
      return true;
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Bad request');
      return true;
    }
  }
  return false;
}

export function createApp(forge: Forge, expectedToken: string): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req).catch(() => null);
      if (body === null) {
        sendError(res, 413, 'Request body too large');
        return;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = url.pathname;
      const segments = pathname.split('/').filter((part) => part !== '').map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });
      const ctx: Ctx = {
        forge,
        method: req.method ?? 'GET',
        segments,
        query: url.searchParams,
        headers: req.headers,
        body,
        host: `http://${req.headers.host ?? '127.0.0.1'}`,
        token: bearerToken(req.headers),
        expectedToken,
      };

      if (pathname === '/healthz' && ctx.method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (await handleGitPaths(ctx, res, pathname)) return;
      if (await handleGraphQL(ctx, res)) return;
      if (await handleMcp(ctx, res)) return;
      if (await handleRest(ctx, res)) return;

      sendError(res, 404, 'Not Found');
    } catch (error) {
      if (!res.headersSent) sendError(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
      else res.end();
    }
  });
  return server;
}

export { nextRequestId };
export type { Packet };

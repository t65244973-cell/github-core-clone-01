// Shared HTTP helpers for the forge's surfaces: deterministic request ids, JSON
// replies (always application/json, never HTML), bearer-token reading, and the
// request context every surface handler receives.

import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { Forge } from './store.ts';

export interface Ctx {
  forge: Forge;
  method: string;
  segments: string[];
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
  host: string;
  token: string | null;
  expectedToken: string;
}

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${String(requestCounter).padStart(8, '0')}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

export function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    'X-GitHub-Request-Id': nextRequestId(),
  });
  res.end(body);
}

export function bearerToken(headers: IncomingHttpHeaders): string | null {
  const authorization = headers.authorization;
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(authorization);
  return match === null ? null : match[1];
}

/** Parse a JSON body; returns null when the body is empty or not valid JSON. */
export function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

export function boolField(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  return typeof value === 'boolean' ? value : undefined;
}

export function intParam(query: URLSearchParams, field: string, fallback: number): number {
  const raw = query.get(field);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

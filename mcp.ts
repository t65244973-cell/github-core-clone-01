// MCP over Streamable HTTP (plain JSON responses, no SSE): the 2026-07-28
// `server/discover` era and the legacy `initialize` eras, six tools over the
// same store the REST surface uses, deterministic `tools/list` bytes, JSON-RPC
// errors (never HTTP 500) for unknown tools and bad calls, and 401 when the
// bearer token is missing or wrong — checked before dispatch on every method.

import type { ServerResponse } from 'node:http';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { isRecord, parseJsonBody, sendError, sendJson, type Ctx } from './util.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
  outputSchema?: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The repository id.' },
        name: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/name of the repository.' },
      },
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The repository id.' },
        name: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/name of the repository.' },
      },
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The issue id.' },
        number: { type: 'number', description: 'The issue number.' },
        title: { type: 'string', description: 'The issue title.' },
        state: { type: 'string', description: 'The issue state.' },
      },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object',
      properties: {
        issues: { type: 'array', description: 'The issues in the repository.' },
      },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The pull request id.' },
        number: { type: 'number', description: 'The pull request number.' },
        title: { type: 'string', description: 'The pull request title.' },
        state: { type: 'string', description: 'The pull request state.' },
      },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object',
      properties: {
        sha: { type: 'string', description: 'The merge commit SHA.' },
        merged: { type: 'boolean', description: 'Whether the pull request was merged.' },
      },
    },
  },
];

// ---------------------------------------------------------------- argument synonyms

function stringArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function numberArg(args: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return undefined;
}

function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const fullName = stringArg(args, 'full_name', 'fullName', 'repository_full_name');
  if (fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0) return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
  }
  const owner = stringArg(args, 'owner', 'owner_login', 'ownerLogin', 'user', 'login');
  const repo = stringArg(args, 'repo', 'repository', 'repo_name', 'name');
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

// ---------------------------------------------------------------- views

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1002 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    url: `https://api.github.com/repos/${repo.fullName}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })),
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.fullName}/issues/${issue.number}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: repo.id * 100000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.fullName}/pulls/${pull.number}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

// ---------------------------------------------------------------- tool dispatch

type ToolResult =
  | { ok: true; structured: Record<string, unknown> }
  | { ok: false; message: string };

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): ToolResult {
  const missing = (field: string): ToolResult => ({ ok: false, message: `Missing required argument: ${field}` });

  if (name === 'create_repo') {
    const repoName = stringArg(args, 'name', 'repo', 'repository');
    if (repoName === undefined) return missing('name');
    const description = stringArg(args, 'description') ?? '';
    const isPrivate = typeof args.private === 'boolean' ? args.private : false;
    const repo = ctx.forge.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
    if (repo === null) return { ok: false, message: 'name already exists on this account' };
    return { ok: true, structured: repoView(repo) };
  }

  if (name === 'get_repo') {
    const resolved = resolveOwnerRepo(args);
    if (resolved === null) return missing('owner/repo');
    const repo = resolved.owner === VIEWER_LOGIN ? ctx.forge.getRepo(resolved.owner, resolved.repo) : undefined;
    if (repo === undefined) return { ok: false, message: 'Not Found' };
    return { ok: true, structured: repoView(repo) };
  }

  if (name === 'create_issue') {
    const resolved = resolveOwnerRepo(args);
    if (resolved === null) return missing('owner/repo');
    const title = stringArg(args, 'title');
    if (title === undefined) return missing('title');
    const repo = resolved.owner === VIEWER_LOGIN ? ctx.forge.getRepo(resolved.owner, resolved.repo) : undefined;
    if (repo === undefined) return { ok: false, message: 'Not Found' };
    const issue: Issue = {
      number: repo.nextNumber,
      title,
      body: stringArg(args, 'body') ?? '',
      state: 'open',
      labels: [],
      comments: [],
      seq: repo.nextNumber,
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return { ok: true, structured: issueView(repo, issue) };
  }

  if (name === 'list_issues') {
    const resolved = resolveOwnerRepo(args);
    if (resolved === null) return missing('owner/repo');
    const repo = resolved.owner === VIEWER_LOGIN ? ctx.forge.getRepo(resolved.owner, resolved.repo) : undefined;
    if (repo === undefined) return { ok: false, message: 'Not Found' };
    const state = stringArg(args, 'state') ?? 'open';
    const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return { ok: true, structured: { issues: issues.map((issue) => issueView(repo, issue)) } };
  }

  if (name === 'create_pull_request') {
    const resolved = resolveOwnerRepo(args);
    if (resolved === null) return missing('owner/repo');
    const title = stringArg(args, 'title');
    if (title === undefined) return missing('title');
    const head = stringArg(args, 'head', 'head_ref', 'headRef');
    if (head === undefined) return missing('head');
    const base = stringArg(args, 'base', 'base_ref', 'baseRef');
    if (base === undefined) return missing('base');
    const repo = resolved.owner === VIEWER_LOGIN ? ctx.forge.getRepo(resolved.owner, resolved.repo) : undefined;
    if (repo === undefined) return { ok: false, message: 'Not Found' };
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return { ok: false, message: 'Head or base branch does not exist' };
    const pull: Pull = {
      number: repo.nextNumber,
      title,
      body: stringArg(args, 'body') ?? '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: repo.nextNumber,
    };
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    return { ok: true, structured: pullView(repo, pull) };
  }

  if (name === 'merge_pull_request') {
    const resolved = resolveOwnerRepo(args);
    if (resolved === null) return missing('owner/repo');
    const pullNumber = numberArg(args, 'pull_number', 'pullNumber', 'pull_request_number', 'number');
    if (pullNumber === undefined) return missing('pull_number');
    const repo = resolved.owner === VIEWER_LOGIN ? ctx.forge.getRepo(resolved.owner, resolved.repo) : undefined;
    if (repo === undefined) return { ok: false, message: 'Not Found' };
    const pull = repo.pulls.find((candidate) => candidate.number === pullNumber);
    if (pull === undefined) return { ok: false, message: 'Not Found' };
    if (pull.merged) return { ok: false, message: 'Pull request is already merged' };
    const result = repo.squashMerge(pull);
    if ('conflict' in result) return { ok: false, message: 'Merge conflict' };
    return { ok: true, structured: { sha: result.sha, merged: true, number: pull.number, state: pull.state } };
  }

  return { ok: false, message: `Unknown tool: ${name}` };
}

// ---------------------------------------------------------------- handler

export async function handleMcp(ctx: Ctx, res: ServerResponse): Promise<boolean> {
  if (ctx.segments.join('/') !== 'mcp') return false;

  // DELETE /mcp (client close) is a no-op success.
  if (ctx.method === 'DELETE') {
    sendJson(res, 200, {});
    return true;
  }
  if (ctx.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }

  // Auth is checked before dispatch on every MCP method.
  if (ctx.token === null || ctx.token !== ctx.expectedToken) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }

  const body = parseJsonBody(ctx.body);
  if (body === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: isRecord(body) ? (body.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }

  const id = body.id ?? null;
  const method = body.method;
  const params = isRecord(body.params) ? body.params : {};
  const sessionId = typeof ctx.headers['mcp-session-id'] === 'string' ? ctx.headers['mcp-session-id'] : undefined;
  const extraHeaders: Record<string, string> = sessionId !== undefined ? { 'Mcp-Session-Id': sessionId } : {};

  const reply = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result }, extraHeaders);
  };
  const replyError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } }, extraHeaders);
  };

  // Notifications (no id) get no JSON-RPC reply.
  const isNotification = id === null || id === undefined;

  if (method === 'server/discover') {
    if (isNotification) {
      res.writeHead(202, extraHeaders);
      res.end();
      return true;
    }
    reply({
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return true;
  }

  if (method === 'initialize') {
    if (isNotification) {
      res.writeHead(202, extraHeaders);
      res.end();
      return true;
    }
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
    const version = SUPPORTED_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS[0];
    reply({
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return true;
  }

  if (method.startsWith('notifications/')) {
    res.writeHead(202, extraHeaders);
    res.end();
    return true;
  }

  if (method === 'ping') {
    if (isNotification) {
      res.writeHead(202, extraHeaders);
      res.end();
      return true;
    }
    reply({});
    return true;
  }

  if (method === 'tools/list') {
    if (isNotification) {
      res.writeHead(202, extraHeaders);
      res.end();
      return true;
    }
    reply({ tools: TOOLS });
    return true;
  }

  if (method === 'tools/call') {
    if (isNotification) {
      res.writeHead(202, extraHeaders);
      res.end();
      return true;
    }
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      replyError(-32602, `Unknown tool: ${name}`);
      return true;
    }
    // Missing required arguments are an application error on the call result.
    const result = callTool(ctx, name, args);
    if (!result.ok) {
      reply({
        content: [{ type: 'text', text: JSON.stringify({ error: result.message }) }],
        structuredContent: { error: result.message },
        isError: true,
      });
      return true;
    }
    reply({
      content: [{ type: 'text', text: JSON.stringify(result.structured) }],
      structuredContent: result.structured,
    });
    return true;
  }

  if (isNotification) {
    res.writeHead(202, extraHeaders);
    res.end();
    return true;
  }
  replyError(-32601, `Method not found: ${method}`);
  return true;
}

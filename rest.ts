// REST v3: repositories, branches, commits, contents, labels, issues, comments
// and pull requests, all over the one shared store. Every reply is JSON; every
// 4xx carries a string message; every reply carries X-GitHub-Request-Id (added
// by the sender in util.ts). Authentication is a bearer token equal to the
// suite token; a missing or wrong token is 401, an unknown owner is 404.

import type { ServerResponse } from 'node:http';
import {
  FIXED_TIME,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  isOid,
  parseCommit,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import {
  boolField,
  intParam,
  isRecord,
  nextRequestId,
  parseJsonBody,
  sendError,
  sendJson,
  stringField,
  type Ctx,
} from './util.ts';

// ---------------------------------------------------------------- views

function userView(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: `MDQ6VXNlcj${id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `https://api.github.com/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
    name: login === VIEWER_LOGIN ? VIEWER_NAME : login,
    email: login === VIEWER_LOGIN ? VIEWER_EMAIL : null,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

function repoView(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length
    + repo.pulls.filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: `MDEwOlJlcG9zaXRvcnk${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: userView(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1002),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `${ctx.host}/api/v3/repos/${repo.fullName}`,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    pushed_at: FIXED_TIME,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    allow_auto_merge: false,
    delete_branch_on_merge: false,
  };
}

function labelView(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: repo.id * 1000 + label.name.length * 31 + label.name.charCodeAt(0),
    node_id: `MDU6TGFiZWw${repo.id}${label.name}`,
    url: `https://api.github.com/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueView(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: `I_kwDO${repo.id}${issue.number}`,
    url: `${ctx.host}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `${ctx.host}/api/v3/repos/${repo.fullName}`,
    labels_url: `${ctx.host}/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `${ctx.host}/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    events_url: `${ctx.host}/api/v3/repos/${repo.fullName}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userView(VIEWER_LOGIN, VIEWER_ID),
    labels: issue.labels.map((label) => labelView(repo, label)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: issue.state === 'closed' ? FIXED_TIME : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function pullView(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const side = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userView(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1002),
    repo: repoView(ctx, repo),
  });
  return {
    id: repo.id * 100000 + pull.number,
    node_id: `PR_kwDO${repo.id}${pull.number}`,
    url: `${ctx.host}/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.fullName}/pull/${pull.number}.patch`,
    issue_url: `${ctx.host}/api/v3/repos/${repo.fullName}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userView(VIEWER_LOGIN, VIEWER_ID),
    body: pull.body,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: pull.state === 'closed' ? FIXED_TIME : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `${ctx.host}/api/v3/repos/${repo.fullName}/pulls/${pull.number}/commits`,
    review_comments_url: `${ctx.host}/api/v3/repos/${repo.fullName}/pulls/${pull.number}/comments`,
    review_comment_url: `${ctx.host}/api/v3/repos/${repo.fullName}/pulls/comments{/number}`,
    comments_url: `${ctx.host}/api/v3/repos/${repo.fullName}/issues/${pull.number}/comments`,
    statuses_url: `${ctx.host}/api/v3/repos/${repo.fullName}/statuses/${headSha}`,
    head: side(pull.headRef, headSha),
    base: side(pull.baseRef, baseSha),
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: null,
    rebaseable: null,
    mergeable_state: 'unknown',
    merged_by: pull.merged ? userView(VIEWER_LOGIN, VIEWER_ID) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commitView(ctx: Ctx, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha,
    node_id: `C_kwDO${repo.id}${sha.slice(0, 8)}`,
    commit: {
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME },
      message: commit.message,
      tree: { sha: commit.tree, url: `${ctx.host}/api/v3/repos/${repo.fullName}/git/trees/${commit.tree}` },
      url: `${ctx.host}/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${ctx.host}/api/v3/repos/${repo.fullName}/commits/${sha}`,
    html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
    comments_url: `${ctx.host}/api/v3/repos/${repo.fullName}/commits/${sha}/comments`,
    author: userView(VIEWER_LOGIN, VIEWER_ID),
    committer: userView(VIEWER_LOGIN, VIEWER_ID),
    parents: commit.parents.map((parent) => ({
      sha: parent,
      url: `${ctx.host}/api/v3/repos/${repo.fullName}/commits/${parent}`,
      html_url: `https://github.com/${repo.fullName}/commit/${parent}`,
    })),
  };
}

function branchView(ctx: Ctx, repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `${ctx.host}/api/v3/repos/${repo.fullName}/commits/${sha}` },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
    protection_url: `${ctx.host}/api/v3/repos/${repo.fullName}/branches/${name}/protection`,
  };
}

// ---------------------------------------------------------------- helpers

function resolveRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.forge.getRepo(owner, name) ?? null;
}

function paginate<T>(items: readonly T[], ctx: Ctx, path: string): { page: T[]; link: string | null } {
  const perPage = Math.min(intParam(ctx.query, 'per_page', 30), 100);
  const page = Math.max(intParam(ctx.query, 'page', 1), 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const hasNext = start + perPage < items.length;
  if (!hasNext) return { page: slice, link: null };
  const next = `${ctx.host}${path}?per_page=${perPage}&page=${page + 1}`;
  return { page: slice, link: `<${next}>; rel="next"` };
}

function linkHeaders(link: string | null): Record<string, string> {
  return link === null ? {} : { Link: link };
}

// ---------------------------------------------------------------- contents

function contentsFileView(ctx: Ctx, repo: Repo, path: string, blobOid: string, commitSha: string): Record<string, unknown> {
  const object = repo.objects.get(blobOid);
  const data = object === undefined ? Buffer.alloc(0) : object.data;
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: blobOid,
    url: `${ctx.host}/api/v3/repos/${repo.fullName}/contents/${path}`,
    git_url: `${ctx.host}/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`,
    html_url: `https://github.com/${repo.fullName}/blob/${commitSha}/${path}`,
    download_url: `https://raw.githubusercontent.com/${repo.fullName}/${commitSha}/${path}`,
    _links: {
      git: `${ctx.host}/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`,
      self: `${ctx.host}/api/v3/repos/${repo.fullName}/contents/${path}`,
      html: `https://github.com/${repo.fullName}/blob/${commitSha}/${path}`,
    },
  };
}

function resolveRefCommit(repo: Repo, ref: string | null): string | undefined {
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const branchTip = repo.refs.get(`refs/heads/${ref}`);
  if (branchTip !== undefined) return branchTip;
  const tagTip = repo.refs.get(`refs/tags/${ref}`);
  if (tagTip !== undefined) return tagTip;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return undefined;
}

// ---------------------------------------------------------------- handler

export async function handleRest(ctx: Ctx, res: ServerResponse): Promise<boolean> {
  const segments = ctx.segments;
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const rest = segments.slice(2);

  // GET /api/v3/ — the root, no auth required (as in the kit starter).
  if (rest.length === 0 && ctx.method === 'GET') {
    sendJson(res, 200, {
      current_user_url: `${ctx.host}/api/v3/user`,
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: `${ctx.host}/api/v3/authorizations`,
      code_search_url: `${ctx.host}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
      commit_search_url: `${ctx.host}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
      emails_url: `${ctx.host}/api/v3/user/emails`,
      emojis_url: `${ctx.host}/api/v3/emojis`,
      events_url: `${ctx.host}/api/v3/events`,
      feeds_url: `${ctx.host}/api/v3/feeds`,
      followers_url: `${ctx.host}/api/v3/users/{user}/followers`,
      following_url: `${ctx.host}/api/v3/users/{user}/following{/target}`,
      gists_url: `${ctx.host}/api/v3/gists{/gist_id}`,
      hub_url: `${ctx.host}/api/v3/hub`,
      issue_search_url: `${ctx.host}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
      issues_url: `${ctx.host}/api/v3/issues`,
      keys_url: `${ctx.host}/api/v3/user/keys`,
      label_search_url: `${ctx.host}/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
      notifications_url: `${ctx.host}/api/v3/notifications{?since,all,participating}`,
      organization_url: `${ctx.host}/api/v3/orgs/{org}`,
      organization_repositories_url: `${ctx.host}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_teams_url: `${ctx.host}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${ctx.host}/api/v3/gists/public`,
      rate_limit_url: `${ctx.host}/api/v3/rate_limit`,
      repository_url: `${ctx.host}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${ctx.host}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
      current_user_repositories_url: `${ctx.host}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${ctx.host}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${ctx.host}/api/v3/gists/starred`,
      topic_search_url: `${ctx.host}/api/v3/search/topics?q={query}{&page,per_page}`,
      user_url: `${ctx.host}/api/v3/users/{user}`,
      user_organizations_url: `${ctx.host}/api/v3/user/orgs`,
      user_repositories_url: `${ctx.host}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${ctx.host}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
    return true;
  }

  if (rest.length === 1 && rest[0] === 'meta' && ctx.method === 'GET') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
    return true;
  }

  // Everything else under /api/v3 needs the bearer token.
  if (ctx.token === null || ctx.token !== ctx.expectedToken) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user' && ctx.method === 'GET') {
    sendJson(res, 200, userView(VIEWER_LOGIN, VIEWER_ID));
    return true;
  }

  // POST /api/v3/user/repos and GET /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (ctx.method === 'POST') {
      const body = parseJsonBody(ctx.body);
      if (!isRecord(body)) {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const name = stringField(body, 'name');
      if (name === undefined || name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
        sendError(res, 422, 'name is required and must be a valid repository name');
        return true;
      }
      const description = stringField(body, 'description') ?? '';
      const isPrivate = boolField(body, 'private') ?? false;
      const repo = ctx.forge.createRepo(VIEWER_LOGIN, name, description, isPrivate);
      if (repo === null) {
        sendError(res, 422, 'name already exists on this account');
        return true;
      }
      sendJson(res, 201, repoView(ctx, repo));
      return true;
    }
    if (ctx.method === 'GET') {
      const repos = ctx.forge.listRepos(VIEWER_LOGIN);
      const { page, link } = paginate(repos, ctx, '/api/v3/user/repos');
      sendJson(res, 200, page.map((repo) => repoView(ctx, repo)), linkHeaders(link));
      return true;
    }
    return true;
  }

  // /api/v3/repos/{owner}/{name}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const name = rest[2];
    const repo = resolveRepo(ctx, owner, name);
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (ctx.method === 'GET') {
        if (repo === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, repoView(ctx, repo));
        return true;
      }
      if (ctx.method === 'PATCH') {
        if (repo === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const body = parseJsonBody(ctx.body);
        if (!isRecord(body)) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const description = stringField(body, 'description');
        if (description !== undefined) repo.description = description;
        const isPrivate = boolField(body, 'private');
        if (isPrivate !== undefined) repo.isPrivate = isPrivate;
        sendJson(res, 200, repoView(ctx, repo));
        return true;
      }
      if (ctx.method === 'DELETE') {
        if (repo === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        ctx.forge.deleteRepo(owner, name);
        res.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId() });
        res.end();
        return true;
      }
      return true;
    }
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }

    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && ctx.method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => branchView(ctx, repo, branch, repo.refs.get(`refs/heads/${branch}`)!));
        sendJson(res, 200, branches);
        return true;
      }
      if (tail.length === 2 && ctx.method === 'GET') {
        const branch = decodeURIComponent(tail[1]);
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) {
          sendError(res, 404, 'Branch not found');
          return true;
        }
        sendJson(res, 200, branchView(ctx, repo, branch, tip));
        return true;
      }
      return true;
    }

    // commits
    if (tail[0] === 'commits' && tail.length === 1 && ctx.method === 'GET') {
      const ref = ctx.query.get('sha');
      const tip = resolveRefCommit(repo, ref);
      const shas = tip === undefined ? [] : repo.commitsFrom(tip);
      const views = shas.map((sha) => commitView(ctx, repo, sha)).filter((view): view is Record<string, unknown> => view !== null);
      const { page, link } = paginate(views, ctx, `/api/v3/repos/${owner}/${name}/commits`);
      sendJson(res, 200, page, linkHeaders(link));
      return true;
    }

    // git refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (ctx.method === 'GET' && tail.length >= 3) {
        const refName = tail.slice(2).map((part) => decodeURIComponent(part)).join('/');
        const oid = repo.refs.get(refName);
        if (oid === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const object = repo.objects.get(oid);
        sendJson(res, 200, {
          ref: refName,
          node_id: `MDM6UmVm${repo.id}${refName}`,
          url: `${ctx.host}/api/v3/repos/${repo.fullName}/git/refs/${refName}`,
          object: { sha: oid, type: object?.type ?? 'commit', url: `${ctx.host}/api/v3/repos/${repo.fullName}/git/${object?.type ?? 'commits'}/${oid}` },
        });
        return true;
      }
      if (ctx.method === 'POST' && tail.length === 2) {
        const body = parseJsonBody(ctx.body);
        if (!isRecord(body)) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const ref = stringField(body, 'ref');
        const sha = stringField(body, 'sha');
        if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
          sendError(res, 422, 'ref and sha are required');
          return true;
        }
        if (repo.refs.has(ref)) {
          sendError(res, 422, 'Reference already exists');
          return true;
        }
        const object = repo.objects.get(sha);
        if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) {
          sendError(res, 422, 'Invalid SHA');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, {
          ref,
          node_id: `MDM6UmVm${repo.id}${ref}`,
          url: `${ctx.host}/api/v3/repos/${repo.fullName}/git/refs/${ref}`,
          object: { sha, type: object.type, url: `${ctx.host}/api/v3/repos/${repo.fullName}/git/${object.type}s/${sha}` },
        });
        return true;
      }
      return true;
    }

    // contents
    if (tail[0] === 'contents') {
      const path = tail.slice(1).map((part) => decodeURIComponent(part)).join('/');
      if (ctx.method === 'GET') {
        const ref = ctx.query.get('ref');
        const commitSha = resolveRefCommit(repo, ref);
        if (commitSha === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const blobOid = repo.blobAt(commitSha, path);
        if (blobOid !== null) {
          sendJson(res, 200, contentsFileView(ctx, repo, path, blobOid, commitSha));
          return true;
        }
        // Directory listing: entries directly under `path` in the commit tree.
        const flat = repo.flatTree(commitSha);
        const prefix = path === '' ? '' : `${path}/`;
        const entries = new Map<string, { name: string; type: 'file' | 'dir'; oid: string; size: number }>();
        for (const [filePath, oid] of flat) {
          if (!filePath.startsWith(prefix)) continue;
          const rest = filePath.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash < 0) {
            const object = repo.objects.get(oid);
            entries.set(rest, { name: rest, type: 'file', oid, size: object?.data.length ?? 0 });
          } else {
            const dir = rest.slice(0, slash);
            if (!entries.has(dir)) entries.set(dir, { name: dir, type: 'dir', oid: '', size: 0 });
          }
        }
        if (entries.size === 0) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const list = [...entries.values()]
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((entry) => ({
            type: entry.type,
            size: entry.size,
            name: entry.name,
            path: prefix + entry.name,
            sha: entry.oid,
            url: `${ctx.host}/api/v3/repos/${repo.fullName}/contents/${prefix}${entry.name}`,
            git_url: entry.type === 'file' ? `${ctx.host}/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}` : `${ctx.host}/api/v3/repos/${repo.fullName}/git/trees/${entry.oid}`,
            html_url: `https://github.com/${repo.fullName}/tree/${commitSha}/${prefix}${entry.name}`,
            download_url: entry.type === 'file' ? `https://raw.githubusercontent.com/${repo.fullName}/${commitSha}/${prefix}${entry.name}` : null,
            _links: {
              git: entry.type === 'file' ? `${ctx.host}/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}` : `${ctx.host}/api/v3/repos/${repo.fullName}/git/trees/${entry.oid}`,
              self: `${ctx.host}/api/v3/repos/${repo.fullName}/contents/${prefix}${entry.name}`,
              html: `https://github.com/${repo.fullName}/tree/${commitSha}/${prefix}${entry.name}`,
            },
          }));
        sendJson(res, 200, list);
        return true;
      }
      if (ctx.method === 'PUT') {
        const body = parseJsonBody(ctx.body);
        if (!isRecord(body)) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const content = stringField(body, 'content');
        const message = stringField(body, 'message') ?? `Update ${path}`;
        const branch = stringField(body, 'branch') ?? repo.defaultBranch;
        const sha = stringField(body, 'sha');
        if (content === undefined) {
          sendError(res, 422, 'content is required');
          return true;
        }
        let contentBuffer: Buffer;
        try {
          contentBuffer = Buffer.from(content, 'base64');
        } catch {
          sendError(res, 422, 'content is not valid base64');
          return true;
        }
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const existing = tip === undefined ? null : repo.blobAt(tip, path);
        if (existing !== null && sha !== undefined && sha !== existing) {
          sendError(res, 409, 'sha does not match the current file');
          return true;
        }
        const { commitSha, contentSha } = repo.commitFile(branch, path, contentBuffer, message);
        sendJson(res, existing === null ? 201 : 200, {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: contentSha,
            size: contentBuffer.length,
            encoding: 'base64',
            url: `${ctx.host}/api/v3/repos/${repo.fullName}/contents/${path}`,
            html_url: `https://github.com/${repo.fullName}/blob/${commitSha}/${path}`,
            git_url: `${ctx.host}/api/v3/repos/${repo.fullName}/git/blobs/${contentSha}`,
            download_url: `https://raw.githubusercontent.com/${repo.fullName}/${commitSha}/${path}`,
            type: 'file',
            _links: {
              git: `${ctx.host}/api/v3/repos/${repo.fullName}/git/blobs/${contentSha}`,
              self: `${ctx.host}/api/v3/repos/${repo.fullName}/contents/${path}`,
              html: `https://github.com/${repo.fullName}/blob/${commitSha}/${path}`,
            },
          },
          commit: {
            sha: commitSha,
            node_id: `C_kwDO${repo.id}${commitSha.slice(0, 8)}`,
            url: `${ctx.host}/api/v3/repos/${repo.fullName}/git/commits/${commitSha}`,
            html_url: `https://github.com/${repo.fullName}/commit/${commitSha}`,
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME },
            message,
            tree: { sha: repo.treeOf(commitSha) ?? '', url: '' },
            parents: [],
            verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
          },
        });
        return true;
      }
      if (ctx.method === 'DELETE') {
        const body = parseJsonBody(ctx.body);
        if (!isRecord(body)) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const message = stringField(body, 'message') ?? `Delete ${path}`;
        const branch = stringField(body, 'branch') ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const existing = tip === undefined ? null : repo.blobAt(tip, path);
        if (existing === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const { commitSha } = repo.deleteFile(branch, path, message);
        sendJson(res, 200, {
          content: null,
          commit: {
            sha: commitSha,
            node_id: `C_kwDO${repo.id}${commitSha.slice(0, 8)}`,
            url: `${ctx.host}/api/v3/repos/${repo.fullName}/git/commits/${commitSha}`,
            html_url: `https://github.com/${repo.fullName}/commit/${commitSha}`,
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME },
            message,
            tree: { sha: repo.treeOf(commitSha) ?? '', url: '' },
            parents: [],
            verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
          },
        });
        return true;
      }
      return true;
    }

    // labels
    if (tail[0] === 'labels') {
      if (ctx.method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((label) => labelView(repo, label)));
        return true;
      }
      if (ctx.method === 'POST' && tail.length === 1) {
        const body = parseJsonBody(ctx.body);
        if (!isRecord(body)) {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        const name = stringField(body, 'name');
        const color = stringField(body, 'color') ?? '000000';
        if (name === undefined || name === '') {
          sendError(res, 422, 'name is required');
          return true;
        }
        if (repo.labels.has(name)) {
          sendError(res, 422, 'Label already exists');
          return true;
        }
        const label: Label = { name, color: color.replace(/^#/, ''), description: stringField(body, 'description') ?? '' };
        repo.labels.set(name, label);
        sendJson(res, 201, labelView(repo, label));
        return true;
      }
      return true;
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (ctx.method === 'POST') {
          const body = parseJsonBody(ctx.body);
          if (!isRecord(body)) {
            sendError(res, 400, 'Problems parsing JSON');
            return true;
          }
          const title = stringField(body, 'title');
          if (title === undefined || title === '') {
            sendError(res, 422, 'title is required');
            return true;
          }
          const labelNames = Array.isArray(body.labels) ? body.labels.filter((item): item is string => typeof item === 'string') : [];
          const labels: Label[] = [];
          for (const labelName of labelNames) {
            const label = repo.labels.get(labelName);
            if (label === undefined) {
              sendError(res, 422, `Label does not exist: ${labelName}`);
              return true;
            }
            labels.push(label);
          }
          const issue: Issue = {
            number: repo.nextNumber,
            title,
            body: stringField(body, 'body') ?? '',
            state: 'open',
            labels,
            comments: [],
            seq: repo.nextNumber,
          };
          repo.nextNumber += 1;
          repo.issues.push(issue);
          sendJson(res, 201, issueView(ctx, repo, issue));
          return true;
        }
        if (ctx.method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
          issues = [...issues].sort((a, b) => {
            const key = sort === 'created' ? a.seq - b.seq : a.number - b.number;
            return direction === 'asc' ? key : -key;
          });
          const { page, link } = paginate(issues, ctx, `/api/v3/repos/${owner}/${name}/issues`);
          sendJson(res, 200, page.map((issue) => issueView(ctx, repo, issue)), linkHeaders(link));
          return true;
        }
        return true;
      }
      const issueNumber = Number.parseInt(tail[1], 10);
      const issue = repo.issues.find((candidate) => candidate.number === issueNumber);
      if (tail.length === 2) {
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (ctx.method === 'GET') {
          sendJson(res, 200, issueView(ctx, repo, issue));
          return true;
        }
        if (ctx.method === 'PATCH') {
          const body = parseJsonBody(ctx.body);
          if (!isRecord(body)) {
            sendError(res, 400, 'Problems parsing JSON');
            return true;
          }
          const state = stringField(body, 'state');
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = stringField(body, 'title');
          if (title !== undefined) issue.title = title;
          const bodyText = stringField(body, 'body');
          if (bodyText !== undefined) issue.body = bodyText;
          sendJson(res, 200, issueView(ctx, repo, issue));
          return true;
        }
        return true;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (ctx.method === 'GET') {
          sendJson(res, 200, issue.comments.map((comment) => ({
            id: comment.id,
            node_id: `IC_kwDO${repo.id}${comment.id}`,
            url: `${ctx.host}/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
            html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
            body: comment.body,
            user: userView(VIEWER_LOGIN, VIEWER_ID),
            created_at: FIXED_TIME,
            updated_at: FIXED_TIME,
            author_association: 'OWNER',
          })));
          return true;
        }
        if (ctx.method === 'POST') {
          const body = parseJsonBody(ctx.body);
          if (!isRecord(body)) {
            sendError(res, 400, 'Problems parsing JSON');
            return true;
          }
          const bodyText = stringField(body, 'body');
          if (bodyText === undefined || bodyText === '') {
            sendError(res, 422, 'body is required');
            return true;
          }
          const comment = { id: repo.nextCommentId, body: bodyText, user: VIEWER_LOGIN };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          sendJson(res, 201, {
            id: comment.id,
            node_id: `IC_kwDO${repo.id}${comment.id}`,
            url: `${ctx.host}/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
            html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
            body: comment.body,
            user: userView(VIEWER_LOGIN, VIEWER_ID),
            created_at: FIXED_TIME,
            updated_at: FIXED_TIME,
            author_association: 'OWNER',
          });
          return true;
        }
        return true;
      }
      return true;
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (ctx.method === 'POST') {
          const body = parseJsonBody(ctx.body);
          if (!isRecord(body)) {
            sendError(res, 400, 'Problems parsing JSON');
            return true;
          }
          const title = stringField(body, 'title');
          const head = stringField(body, 'head');
          const base = stringField(body, 'base');
          if (title === undefined || head === undefined || base === undefined) {
            sendError(res, 422, 'title, head and base are required');
            return true;
          }
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined || baseSha === undefined) {
            sendError(res, 422, 'Head or base branch does not exist');
            return true;
          }
          const pull: Pull = {
            number: repo.nextNumber,
            title,
            body: stringField(body, 'body') ?? '',
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
          sendJson(res, 201, pullView(ctx, repo, pull));
          return true;
        }
        if (ctx.method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          let pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
          pulls = [...pulls].sort((a, b) => {
            const key = sort === 'created' ? a.seq - b.seq : a.number - b.number;
            return direction === 'asc' ? key : -key;
          });
          const { page, link } = paginate(pulls, ctx, `/api/v3/repos/${owner}/${name}/pulls`);
          sendJson(res, 200, page.map((pull) => pullView(ctx, repo, pull)), linkHeaders(link));
          return true;
        }
        return true;
      }
      const pullNumber = Number.parseInt(tail[1], 10);
      const pull = repo.pulls.find((candidate) => candidate.number === pullNumber);
      if (tail.length === 2) {
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (ctx.method === 'GET') {
          sendJson(res, 200, pullView(ctx, repo, pull));
          return true;
        }
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files' && ctx.method === 'GET') {
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
        const mergeBase = repo.mergeBase(baseTip, headTip);
        const diff = mergeBase === null ? [] : repo.diffAgainstBase(mergeBase, headTip);
        const files = diff.map((entry) => {
          const stats = repo.fileStats(entry);
          return {
            sha: stats.status === 'removed' ? entry.oldOid : entry.newOid,
            filename: stats.filename,
            status: stats.status === 'removed' ? 'changed' : stats.status,
            additions: stats.additions,
            deletions: stats.deletions,
            changes: stats.changes,
            blob_url: `https://github.com/${repo.fullName}/blob/${headTip}/${stats.filename}`,
            raw_url: `https://github.com/${repo.fullName}/raw/${headTip}/${stats.filename}`,
            contents_url: `${ctx.host}/api/v3/repos/${repo.fullName}/contents/${stats.filename}?ref=${headTip}`,
            patch: '',
          };
        });
        sendJson(res, 200, files);
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && ctx.method === 'PUT') {
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (pull.merged) {
          sendError(res, 405, 'Pull request is already merged');
          return true;
        }
        const result = repo.squashMerge(pull);
        if ('conflict' in result) {
          sendError(res, 405, 'Merge conflict');
          return true;
        }
        sendJson(res, 200, {
          sha: result.sha,
          merged: true,
          message: 'Pull request successfully merged.',
        });
        return true;
      }
      return true;
    }
  }

  // Unknown /api/v3 route: JSON 404 (never HTML).
  if (rest.length > 0) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  return false;
}

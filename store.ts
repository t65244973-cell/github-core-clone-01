// The forge's store: one in-memory model shared by the git, REST, GraphQL and MCP
// surfaces. Everything is deterministic: fixed timestamps, counter ids, no clock and
// no randomness anywhere a response can see. Repositories, git objects, issues, pull
// requests, comments and labels all live here; the surfaces are thin views over it.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const FIXED_TIME = '2025-01-01T00:00:00Z';
export const FIXED_EPOCH = 1735689600;
export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: entries sort by name, a directory as if its name ended with '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  // Store the message exactly as given: the REST view echoes it back verbatim,
  // so no trailing newline is added here.
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function ident(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

export function viewerIdent(): string {
  return ident(VIEWER_NAME, VIEWER_EMAIL, FIXED_EPOCH);
}

// ---------------------------------------------------------------- issues, pulls, labels

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

// ---------------------------------------------------------------- repository

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch = 'main';
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  nextNumber = 1;
  nextCommentId = 1;
  private seqCounter = 0;
  /** Insertion order of each commit, newest last; drives GET /commits ordering. */
  readonly commitSeq = new Map<string, number>();

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putCommit(data: Buffer): string {
    const oid = this.putObject('commit', data);
    if (!this.commitSeq.has(oid)) {
      this.seqCounter += 1;
      this.commitSeq.set(oid, this.seqCounter);
    }
    return oid;
  }

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  /** Every commit reachable from `tip`, newest first by insertion order. */
  commitsFrom(tip: string | undefined): string[] {
    if (tip === undefined || !isOid(tip)) return [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return [...seen].sort((a, b) => (this.commitSeq.get(b) ?? 0) - (this.commitSeq.get(a) ?? 0));
  }

  /** Is `ancestor` reachable from `descendant` (or equal to it)? */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** The newest commit reachable from both tips (the merge base), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queue: string[] = [a];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (ancestorsA.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      ancestorsA.add(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    const ordered = this.commitsFrom(b);
    for (const oid of ordered) if (ancestorsA.has(oid)) return oid;
    return null;
  }

  /** All objects reachable from the given tips (commits, trees, blobs, tags). */
  reachable(tips: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const queue: string[] = [];
    for (const tip of tips) if (isOid(tip)) queue.push(tip);
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (out.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      out.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) queue.push(entry.oid);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
    return out;
  }

  /** The blob oid at `path` in the tree of `commitOid`, or null. */
  blobAt(commitOid: string, path: string): string | null {
    const commit = this.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    const segments = path.split('/').filter((part) => part !== '');
    for (let index = 0; index < segments.length; index += 1) {
      const tree = this.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      if (index === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
      treeOid = entry.oid;
    }
    return null;
  }

  /** The tree oid of `commitOid`, or null. */
  treeOf(commitOid: string): string | null {
    const commit = this.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return null;
    return parseCommit(commit.data).tree;
  }

  /** A new tree oid equal to `baseTreeOid` with `path` set to `blobOid` (or removed when null). */
  setPath(baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((part) => part !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = treeOid === null ? [] : parseTree(this.objects.get(treeOid)?.data ?? Buffer.alloc(0));
      const name = segments[depth];
      const last = depth === segments.length - 1;
      const next: TreeEntry[] = [];
      let replaced = false;
      for (const entry of entries) {
        if (entry.name !== name) {
          next.push(entry);
          continue;
        }
        replaced = true;
        if (last) {
          if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
        } else {
          const child = build(entry.mode === '40000' ? entry.oid : null, depth + 1);
          const childEntries = parseTree(this.objects.get(child)?.data ?? Buffer.alloc(0));
          if (childEntries.length > 0) next.push({ mode: '40000', name, oid: child });
        }
      }
      if (!replaced) {
        if (last) {
          if (blobOid !== null) next.push({ mode: '100644', name, oid: blobOid });
        } else {
          const child = build(null, depth + 1);
          const childEntries = parseTree(this.objects.get(child)?.data ?? Buffer.alloc(0));
          if (childEntries.length > 0) next.push({ mode: '40000', name, oid: child });
        }
      }
      return this.putObject('tree', buildTree(next));
    };
    return build(baseTreeOid, 0);
  }

  /** Flat map of path -> blob oid for the tree of `commitOid`. */
  flatTree(commitOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const treeOid = this.treeOf(commitOid);
    if (treeOid === null) return out;
    const walk = (oid: string, prefix: string): void => {
      const tree = this.objects.get(oid);
      if (tree === undefined || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, entry.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Three-dot diff: paths changed between the merge-base tree and `headOid`'s tree. */
  diffAgainstBase(baseOid: string, headOid: string): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
    const baseTree = this.flatTree(baseOid);
    const headTree = this.flatTree(headOid);
    const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
    for (const path of [...paths].sort()) {
      const oldOid = baseTree.get(path) ?? null;
      const newOid = headTree.get(path) ?? null;
      if (oldOid === newOid) continue;
      if (oldOid === null) out.push({ path, status: 'added', oldOid, newOid });
      else if (newOid === null) out.push({ path, status: 'removed', oldOid, newOid });
      else out.push({ path, status: 'modified', oldOid, newOid });
    }
    return out;
  }

  /** Line counts for a pull file entry. */
  fileStats(entry: { status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }): PullFile {
    const countLines = (oid: string | null): string[] => {
      if (oid === null) return [];
      const object = this.objects.get(oid);
      if (object === undefined) return [];
      return object.data.toString('utf8').split('\n').filter((line, index, arr) => !(index === arr.length - 1 && line === ''));
    };
    const oldLines = countLines(entry.oldOid);
    const newLines = countLines(entry.newOid);
    let additions = 0;
    let deletions = 0;
    if (entry.status === 'added') additions = newLines.length;
    else if (entry.status === 'removed') deletions = oldLines.length;
    else {
      const oldSet = new Map<string, number>();
      for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
      for (const line of newLines) {
        const remaining = oldSet.get(line) ?? 0;
        if (remaining > 0) oldSet.set(line, remaining - 1);
        else additions += 1;
      }
      deletions = [...oldSet.values()].reduce((sum, count) => sum + count, 0);
      if (additions === 0 && deletions === 0) additions = 1;
    }
    return { filename: entry.path, status: entry.status, additions, deletions, changes: additions + deletions };
  }

  /** Does merging `pull` conflict with the current base tip? */
  mergeConflicts(pull: Pull): boolean {
    const baseTip = this.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = this.refs.get(`refs/heads/${pull.headRef}`);
    if (baseTip === undefined || headTip === undefined) return false;
    const base = this.mergeBase(baseTip, headTip);
    if (base === null) return false;
    const headDiff = this.diffAgainstBase(base, headTip);
    const baseTree = this.flatTree(baseTip);
    const mergeBaseTree = this.flatTree(base);
    for (const change of headDiff) {
      const baseOid = baseTree.get(change.path) ?? null;
      const mergeBaseOid = mergeBaseTree.get(change.path) ?? null;
      if (baseOid !== mergeBaseOid && baseOid !== change.newOid) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch (shared by REST and GraphQL). */
  squashMerge(pull: Pull): { sha: string } | { conflict: true } {
    if (this.mergeConflicts(pull)) return { conflict: true };
    const baseTip = this.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const headTip = this.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const mergeBase = this.mergeBase(baseTip, headTip);
    const diff = mergeBase === null ? [] : this.diffAgainstBase(mergeBase, headTip);
    let tree = this.treeOf(baseTip);
    for (const change of diff) {
      if (change.status === 'removed') tree = this.setPath(tree, change.path, null);
      else if (change.newOid !== null) tree = this.setPath(tree, change.path, change.newOid);
    }
    const mergeCommit = buildCommit({
      tree: tree ?? '',
      parents: [baseTip],
      message: `${pull.title} (#${pull.number})\n\n${pull.body}`,
      author: viewerIdent(),
      committer: viewerIdent(),
    });
    const mergeSha = this.putCommit(mergeCommit);
    this.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_TIME;
    pull.mergeCommitSha = mergeSha;
    return { sha: mergeSha };
  }

  /** Commit one file on `branch` (creating the branch tip when unborn). */
  commitFile(branch: string, path: string, content: Buffer, message: string): { commitSha: string; contentSha: string } {
    const ref = `refs/heads/${branch}`;
    const tip = this.refs.get(ref);
    const contentSha = this.putObject('blob', content);
    const baseTree = tip === undefined ? null : this.treeOf(tip);
    const tree = this.setPath(baseTree, path, contentSha);
    const commit = buildCommit({
      tree,
      parents: tip === undefined ? [] : [tip],
      message,
      author: viewerIdent(),
      committer: viewerIdent(),
    });
    const commitSha = this.putCommit(commit);
    this.refs.set(ref, commitSha);
    return { commitSha, contentSha };
  }

  /** Delete one file on `branch`. */
  deleteFile(branch: string, path: string, message: string): { commitSha: string } {
    const ref = `refs/heads/${branch}`;
    const tip = this.refs.get(ref);
    if (tip === undefined) throw new Error('branch has no tip');
    const baseTree = this.treeOf(tip);
    const tree = this.setPath(baseTree, path, null);
    const commit = buildCommit({
      tree,
      parents: [tip],
      message,
      author: viewerIdent(),
      committer: viewerIdent(),
    });
    const commitSha = this.putCommit(commit);
    this.refs.set(ref, commitSha);
    return { commitSha };
  }
}

// ---------------------------------------------------------------- the forge

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 10000;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo = new Repo(this.nextRepoId, owner, name, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }
}

// GraphQL v4: a hand-rolled parser and executor for the fixed set of documents
// the sealed suite sends (viewer, repository, issues, pull requests, mutations,
// node, and __type introspection), plus JSON-array batching. Global ids are
// opaque base64 of a namespaced string and stable across reads. Unknown fields
// answer HTTP 200 with an errors array naming the field, as GitHub does.

import type { ServerResponse } from 'node:http';
import {
  FIXED_TIME,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { isRecord, parseJsonBody, sendError, sendJson, type Ctx } from './util.ts';

// ---------------------------------------------------------------- global ids

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return globalId('IssueComment', `${repo.id}:${issue.number}:${commentId}`);
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1], 10);
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------- known fields (for the unknown-field error)

const KNOWN_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt', 'updatedAt'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'author', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelEdge: ['node', 'cursor'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileEdge: ['node', 'cursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$()[]{}:=@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number.parseFloat(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  operation: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value} in GraphQL document, got ${JSON.stringify(token)}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.next().value as string;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipVariableDefinitions();
        while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') this.skipDirective();
        operations.push({ operation: token.value as 'query' | 'mutation', name, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') this.skipDirective();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token)} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirective(): void {
    this.expectPunct('@');
    this.expectName();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.expectPunct('(');
      let depth = 1;
      while (depth > 0) {
        const token = this.next();
        if (token.kind === 'punct' && token.value === '(') depth += 1;
        else if (token.kind === 'punct' && token.value === ')') depth -= 1;
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') this.skipDirective();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next !== undefined && next.kind === 'name') {
        const name = this.next().value as string;
        while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') this.skipDirective();
        return { kind: 'spread', name };
      }
      while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') this.skipDirective();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') this.skipDirective();
    const selections = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)} in GraphQL document`);
  }
}

// ---------------------------------------------------------------- execution

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

function valueOf(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

interface ConnectionItem {
  node: GqlObject;
}

function makeConnection(typename: string, items: ConnectionItem[], args: Record<string, unknown>): GqlObject {
  const afterIndex = indexFromCursor(typeof args.after === 'string' ? args.after : null);
  const start = afterIndex + 1;
  const first = typeof args.first === 'number' ? args.first : items.length;
  const sliced = items.slice(start, start + first);
  const endCursor = sliced.length > 0 ? cursorFor(start + sliced.length - 1) : null;
  const startCursor = sliced.length > 0 ? cursorFor(start) : null;
  return {
    __typename: typename,
    __nodes: sliced.map((item) => item.node),
    __edges: sliced.map((item, index) => ({
      __typename: typename.replace('Connection', 'Edge'),
      node: item.node,
      cursor: cursorFor(start + index),
    })),
    __pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + sliced.length < items.length,
      hasPreviousPage: start > 0,
      startCursor,
      endCursor,
    },
    __totalCount: items.length,
  };
}

class Executor {
  private errors: Array<{ message: string }> = [];
  private readonly forge: import('./store.ts').Forge;

  constructor(forge: import('./store.ts').Forge) {
    this.forge = forge;
  }

  getErrors(): Array<{ message: string }> {
    return this.errors;
  }

  execute(operation: Operation, variables: Record<string, unknown>, fragments: Map<string, FragmentDef>): Record<string, unknown> {
    const root: GqlObject = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
    return this.resolveSelections(root, operation.selections, variables, fragments) as Record<string, unknown>;
  }

  private resolveSelections(parent: GqlObject, selections: SelectionNode[], variables: Record<string, unknown>, fragments: Map<string, FragmentDef>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'inline') {
        if (selection.typeCondition === null || selection.typeCondition === (parent.__typename as string)) {
          Object.assign(out, this.resolveSelections(parent, selection.selections, variables, fragments));
        }
        continue;
      }
      if (selection.kind === 'spread') {
        const fragment = fragments.get(selection.name);
        if (fragment !== undefined && (fragment.typeCondition === (parent.__typename as string) || fragment.typeCondition === '')) {
          Object.assign(out, this.resolveSelections(parent, fragment.selections, variables, fragments));
        } else if (fragment !== undefined) {
          Object.assign(out, this.resolveSelections(parent, fragment.selections, variables, fragments));
        }
        continue;
      }
      const field = selection.field;
      const key = field.alias ?? field.name;
      out[key] = this.resolveField(parent, field, variables, fragments);
    }
    return out;
  }

  private resolveField(parent: GqlObject, field: FieldNode, variables: Record<string, unknown>, fragments: Map<string, FragmentDef>): unknown {
    const typename = parent.__typename as string;
    if (field.name === '__typename') return typename;
    const known = KNOWN_FIELDS[typename];
    if (known !== undefined && !known.includes(field.name)) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typename}".` });
      return null;
    }
    const args = argMap(field, variables);
    const value = this.fieldValue(parent, field, args);
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      if (field.selections.length === 0) return value;
      return value.map((item) => {
        if (typeof item === 'object' && item !== null && '__typename' in (item as Record<string, unknown>)) {
          return this.resolveSelections(item as GqlObject, field.selections, variables, fragments);
        }
        return item;
      });
    }
    if (typeof value !== 'object') return value;
    const object = value as GqlObject;
    if (field.selections.length === 0) return object;
    return this.resolveSelections(object, field.selections, variables, fragments);
  }

  private fieldValue(parent: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
    const typename = parent.__typename as string;
    switch (typename) {
      case 'Query':
        return this.queryField(field, args);
      case 'Mutation':
        return this.mutationField(field, args);
      case 'User':
        return this.userField(parent, field);
      case 'Repository':
        return this.repositoryField(parent, field, args);
      case 'Issue':
        return this.issueField(parent, field, args);
      case 'PullRequest':
        return this.pullField(parent, field, args);
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'IssueCommentConnection':
      case 'LabelConnection':
      case 'PullRequestFileConnection':
        return this.connectionField(parent, field);
      case 'IssueEdge':
      case 'PullRequestEdge':
      case 'IssueCommentEdge':
      case 'LabelEdge':
      case 'PullRequestFileEdge':
        return field.name === 'node' ? parent.node : field.name === 'cursor' ? parent.cursor : null;
      case 'PageInfo':
        return parent[field.name] ?? null;
      case 'Ref':
        return parent[field.name] ?? null;
      case 'Label':
        return parent[field.name] ?? null;
      case 'IssueComment':
        return this.commentField(parent, field);
      case 'PullRequestFile':
        return parent[field.name] ?? null;
      case '__Type':
        return this.typeField(parent, field, args);
      case '__Field':
      case '__EnumValue':
        return parent[field.name] ?? null;
      case 'CreateIssuePayload':
      case 'CloseIssuePayload':
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload':
      case 'AddCommentPayload':
        return parent[field.name] ?? null;
      default:
        return null;
    }
  }

  // ---------------------------------------------------------- Query root

  private queryField(field: FieldNode, args: Record<string, unknown>): unknown {
    if (field.name === 'viewer') {
      return {
        __typename: 'User',
        id: globalId('User', String(VIEWER_ID)),
        databaseId: VIEWER_ID,
        login: VIEWER_LOGIN,
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        url: `https://github.com/${VIEWER_LOGIN}`,
        avatarUrl: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      };
    }
    if (field.name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = this.forge.getRepo(owner, name);
      if (repo === undefined) return null;
      return this.repositoryObject(repo);
    }
    if (field.name === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repoId = Number.parseInt(decoded.key, 10);
        for (const repo of this.forge.repos.values()) {
          if (repo.id === repoId) return this.repositoryObject(repo);
        }
        return null;
      }
      if (decoded.kind === 'Issue') {
        const [repoIdText, numberText] = decoded.key.split(':');
        const repoId = Number.parseInt(repoIdText, 10);
        const number = Number.parseInt(numberText, 10);
        for (const repo of this.forge.repos.values()) {
          if (repo.id !== repoId) continue;
          const issue = repo.issues.find((candidate) => candidate.number === number);
          return issue === undefined ? null : this.issueObject(repo, issue);
        }
        return null;
      }
      if (decoded.kind === 'PullRequest') {
        const [repoIdText, numberText] = decoded.key.split(':');
        const repoId = Number.parseInt(repoIdText, 10);
        const number = Number.parseInt(numberText, 10);
        for (const repo of this.forge.repos.values()) {
          if (repo.id !== repoId) continue;
          const pull = repo.pulls.find((candidate) => candidate.number === number);
          return pull === undefined ? null : this.pullObject(repo, pull);
        }
        return null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = typeof args.name === 'string' ? args.name : '';
      if (name === 'SearchType') {
        return { __typename: '__Type', name: 'SearchType', kind: 'ENUM', description: 'The types of search results.', __enumValues: SEARCH_TYPE_VALUES };
      }
      if (KNOWN_FIELDS[name] !== undefined) {
        return { __typename: '__Type', name, kind: 'OBJECT', description: '', __fields: KNOWN_FIELDS[name] };
      }
      return null;
    }
    return null;
  }

  // ---------------------------------------------------------- Mutation root

  private mutationField(field: FieldNode, args: Record<string, unknown>): unknown {
    const input = isRecord(args.input) ? args.input : {};
    const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
    if (field.name === 'createIssue') {
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repositoryId);
      if (decoded === null || decoded.kind !== 'Repository') return null;
      const repo = [...this.forge.repos.values()].find((candidate) => candidate.id === Number.parseInt(decoded.key, 10));
      if (repo === undefined) return null;
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue: Issue = { number: repo.nextNumber, title, body, state: 'open', labels: [], comments: [], seq: repo.nextNumber };
      repo.nextNumber += 1;
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', clientMutationId, issue: this.issueObject(repo, issue) };
    }
    if (field.name === 'closeIssue') {
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const found = this.findIssue(issueId);
      if (found === null) return null;
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', clientMutationId, issue: this.issueObject(found.repo, found.issue) };
    }
    if (field.name === 'createPullRequest') {
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repositoryId);
      if (decoded === null || decoded.kind !== 'Repository') return null;
      const repo = [...this.forge.repos.values()].find((candidate) => candidate.id === Number.parseInt(decoded.key, 10));
      if (repo === undefined) return null;
      const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const headSha = repo.refs.get(`refs/heads/${headRefName}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRefName}`);
      if (headSha === undefined || baseSha === undefined) return null;
      const pull: Pull = {
        number: repo.nextNumber,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef: headRefName,
        baseRef: baseRefName,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: repo.nextNumber,
      };
      repo.nextNumber += 1;
      repo.pulls.push(pull);
      return { __typename: 'CreatePullRequestPayload', clientMutationId, pullRequest: this.pullObject(repo, pull) };
    }
    if (field.name === 'mergePullRequest') {
      const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const decoded = decodeGlobalId(pullRequestId);
      if (decoded === null || decoded.kind !== 'PullRequest') return null;
      const [repoIdText, numberText] = decoded.key.split(':');
      const repo = [...this.forge.repos.values()].find((candidate) => candidate.id === Number.parseInt(repoIdText, 10));
      if (repo === undefined) return null;
      const pull = repo.pulls.find((candidate) => candidate.number === Number.parseInt(numberText, 10));
      if (pull === undefined || pull.merged) return null;
      const result = repo.squashMerge(pull);
      if ('conflict' in result) return null;
      return { __typename: 'MergePullRequestPayload', clientMutationId, pullRequest: this.pullObject(repo, pull) };
    }
    if (field.name === 'addComment') {
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const found = this.findIssue(subjectId);
      if (found === null) return null;
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: found.repo.nextCommentId, body, user: VIEWER_LOGIN };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        clientMutationId,
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: this.commentObject(found.repo, found.issue, comment),
          cursor: cursorFor(found.issue.comments.length - 1),
        },
      };
    }
    return null;
  }

  private findIssue(global: string): { repo: Repo; issue: Issue } | null {
    const decoded = decodeGlobalId(global);
    if (decoded === null || decoded.kind !== 'Issue') return null;
    const [repoIdText, numberText] = decoded.key.split(':');
    const repoId = Number.parseInt(repoIdText, 10);
    const number = Number.parseInt(numberText, 10);
    for (const repo of this.forge.repos.values()) {
      if (repo.id !== repoId) continue;
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue !== undefined) return { repo, issue };
    }
    return null;
  }

  // ---------------------------------------------------------- objects

  private userObject(): GqlObject {
    return {
      __typename: 'User',
      id: globalId('User', String(VIEWER_ID)),
      databaseId: VIEWER_ID,
      login: VIEWER_LOGIN,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      url: `https://github.com/${VIEWER_LOGIN}`,
      avatarUrl: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    };
  }

  private repositoryObject(repo: Repo): GqlObject {
    return {
      __typename: 'Repository',
      __repo: repo,
      id: repoGlobalId(repo),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: repo.fullName,
      owner: this.userObject(),
      defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch, target: null },
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
      url: `https://github.com/${repo.fullName}`,
      description: repo.description,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    };
  }

  private issueObject(repo: Repo, issue: Issue): GqlObject {
    return {
      __typename: 'Issue',
      __repo: repo,
      __issue: issue,
      id: issueGlobalId(repo, issue),
      databaseId: issue.number,
      number: issue.number,
      title: issue.title,
      state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
      body: issue.body,
      url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      author: this.userObject(),
      repository: this.repositoryObject(repo),
    };
  }

  private pullObject(repo: Repo, pull: Pull): GqlObject {
    const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    return {
      __typename: 'PullRequest',
      __repo: repo,
      __pull: pull,
      id: pullGlobalId(repo, pull),
      databaseId: pull.number,
      number: pull.number,
      title: pull.title,
      state,
      body: pull.body,
      url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
      headRefName: pull.headRef,
      baseRefName: pull.baseRef,
      merged: pull.merged,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      author: this.userObject(),
      repository: this.repositoryObject(repo),
    };
  }

  private commentObject(repo: Repo, issue: Issue, comment: { id: number; body: string; user: string }): GqlObject {
    return {
      __typename: 'IssueComment',
      id: commentGlobalId(repo, issue, comment.id),
      databaseId: comment.id,
      body: comment.body,
      author: this.userObject(),
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    };
  }

  // ---------------------------------------------------------- type fields

  private userField(parent: GqlObject, field: FieldNode): unknown {
    return parent[field.name] ?? null;
  }

  private repositoryField(parent: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
    const repo = parent.__repo as Repo;
    if (field.name === 'issue') {
      const number = typeof args.number === 'number' ? args.number : -1;
      const issue = repo.issues.find((candidate) => candidate.number === number);
      return issue === undefined ? null : this.issueObject(repo, issue);
    }
    if (field.name === 'issues') {
      let issues = [...repo.issues];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
      if (orderBy !== null && orderBy.field === 'CREATED_AT') {
        issues.sort((a, b) => (orderBy.direction === 'DESC' ? b.number - a.number : a.number - b.number));
      } else {
        issues.sort((a, b) => a.number - b.number);
      }
      return makeConnection('IssueConnection', issues.map((issue) => ({ node: this.issueObject(repo, issue) })), args);
    }
    if (field.name === 'pullRequest') {
      const number = typeof args.number === 'number' ? args.number : -1;
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      return pull === undefined ? null : this.pullObject(repo, pull);
    }
    if (field.name === 'pullRequests') {
      let pulls = [...repo.pulls];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : 'merged')));
        pulls = pulls.filter((pull) => {
          const mapped = pull.merged ? 'merged' : pull.state;
          return wanted.has(mapped);
        });
      }
      pulls.sort((a, b) => a.number - b.number);
      return makeConnection('PullRequestConnection', pulls.map((pull) => ({ node: this.pullObject(repo, pull) })), args);
    }
    return parent[field.name] ?? null;
  }

  private issueField(parent: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
    const repo = parent.__repo as Repo;
    const issue = parent.__issue as Issue;
    if (field.name === 'labels') {
      return makeConnection('LabelConnection', issue.labels.map((label) => ({
        node: { __typename: 'Label', id: globalId('Label', `${repo.id}:${label.name}`), name: label.name, color: label.color, description: label.description },
      })), args);
    }
    if (field.name === 'comments') {
      return makeConnection('IssueCommentConnection', issue.comments.map((comment) => ({
        node: this.commentObject(repo, issue, comment),
      })), args);
    }
    return parent[field.name] ?? null;
  }

  private pullField(parent: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
    const repo = parent.__repo as Repo;
    const pull = parent.__pull as Pull;
    if (field.name === 'mergeable') {
      return repo.mergeConflicts(pull) ? 'CONFLICTING' : 'MERGEABLE';
    }
    if (field.name === 'files') {
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const mergeBase = repo.mergeBase(baseTip, headTip);
      const diff = mergeBase === null ? [] : repo.diffAgainstBase(mergeBase, headTip);
      return makeConnection('PullRequestFileConnection', diff.map((entry) => {
        const stats = repo.fileStats(entry);
        return {
          node: {
            __typename: 'PullRequestFile',
            path: entry.path,
            additions: stats.additions,
            deletions: stats.deletions,
            changeType: stats.status === 'added' ? 'ADDED' : stats.status === 'removed' ? 'DELETED' : 'MODIFIED',
          },
        };
      }), args);
    }
    return parent[field.name] ?? null;
  }

  private connectionField(parent: GqlObject, field: FieldNode): unknown {
    if (field.name === 'nodes') return parent.__nodes ?? [];
    if (field.name === 'edges') return parent.__edges ?? [];
    if (field.name === 'pageInfo') return parent.__pageInfo ?? null;
    if (field.name === 'totalCount') return parent.__totalCount ?? 0;
    return null;
  }

  private commentField(parent: GqlObject, field: FieldNode): unknown {
    return parent[field.name] ?? null;
  }

  private typeField(parent: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
    if (field.name === 'fields') {
      const names = (parent.__fields as string[] | undefined) ?? [];
      return names.map((name) => ({ __typename: '__Field', name, description: '' }));
    }
    if (field.name === 'enumValues') {
      const names = (parent.__enumValues as string[] | undefined) ?? [];
      return names.map((name) => ({ __typename: '__EnumValue', name, description: '' }));
    }
    return parent[field.name] ?? null;
  }
}

// ---------------------------------------------------------------- handler

export async function handleGraphQL(ctx: Ctx, res: ServerResponse): Promise<boolean> {
  if (ctx.segments.join('/') !== 'api/graphql') return false;
  if (ctx.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (ctx.token === null || ctx.token !== ctx.expectedToken) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }
  const body = parseJsonBody(ctx.body);
  if (body === null) {
    sendError(res, 400, 'Problems parsing JSON');
    return true;
  }
  const requests = Array.isArray(body) ? body : [body];
  const results: unknown[] = [];
  for (const request of requests) {
    if (!isRecord(request) || typeof request.query !== 'string') {
      results.push({ data: null, errors: [{ message: 'A query is required.' }] });
      continue;
    }
    const variables = isRecord(request.variables) ? (request.variables as Record<string, unknown>) : {};
    try {
      const { operations, fragments } = new Parser(tokenize(request.query)).parseDocument();
      const operationName = typeof request.operationName === 'string' ? request.operationName : null;
      const operation = operationName === null
        ? operations[0]
        : operations.find((candidate) => candidate.name === operationName) ?? operations[0];
      if (operation === undefined) {
        results.push({ data: null, errors: [{ message: 'No operation found.' }] });
        continue;
      }
      const executor = new Executor(ctx.forge);
      const data = executor.execute(operation, variables, fragments);
      const errors = executor.getErrors();
      results.push(errors.length > 0 ? { data, errors } : { data });
    } catch (error) {
      results.push({ data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL error' }] });
    }
  }
  sendJson(res, 200, Array.isArray(body) ? results : results[0]);
  return true;
}

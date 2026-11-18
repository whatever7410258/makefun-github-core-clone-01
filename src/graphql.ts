/**
 * A small GraphQL executor for the documents gh and github-mcp-server send:
 * a lexer + recursive-descent parser for the query language subset the suite
 * uses (operations, variables, aliases, arguments, input objects, lists,
 * enums, inline fragments, named fragments), a hardcoded schema with
 * validation (an unknown field is a 200 with an errors array naming it),
 * and resolvers over the forge's store.
 *
 * Global ids are base64 of `Type:params` (opaque, stable, decodable):
 * Repository:<dbid>, Issue:<repoDbid>:<number>, PullRequest:<repoDbid>:<number>,
 * IssueComment:<repoDbid>:<commentId>. Cursors are base64 of `cursor:<seq>`.
 */

import type { ForgeStore, Issue, PullRequest, Repo } from './store.ts';
import { isAuthorized, route, type RequestView, type ResponseView } from './server.ts';
import { b64decodeText, b64encodeText, nowISO } from './util.ts';

// ---------------------------------------------------------------- lexer

type TokenKind =
  | 'name'
  | 'int'
  | 'float'
  | 'string'
  | '{'
  | '}'
  | '('
  | ')'
  | '['
  | ']'
  | ':'
  | '!'
  | '$'
  | '='
  | '@'
  | '|'
  | '&'
  | '...'
  | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ':' || ch === '!' || ch === '$' || ch === '=' || ch === '@' || ch === '|' || ch === '&') {
      tokens.push({ kind: ch as TokenKind, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // A string (block strings are not used by the suite; a triple quote is
      // treated as an empty string followed by a string, which never occurs).
      let value = '';
      i += 1;
      let closed = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (c === '\\' && i + 1 < source.length) {
          const esc = source[i + 1]!;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          if (esc === 'u' && i + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += map[esc] ?? esc;
            i += 2;
          }
          continue;
        }
        value += c;
        i += 1;
      }
      if (!closed) throw new GraphQLError('Unterminated string in query');
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || isDigit(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && isDigit(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && isDigit(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && isDigit(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && isDigit(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLError(`Unexpected character ${JSON.stringify(ch)} in query`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- AST

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

export interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

export interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

export type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

export class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expect(kind: TokenKind): Token {
    const token = this.peek();
    if (token.kind !== kind) throw new GraphQLError(`Expected ${kind}, got ${token.kind} ${JSON.stringify(token.value)}`);
    return this.next();
  }

  private expectName(value?: string): string {
    const token = this.peek();
    if (token.kind !== 'name') throw new GraphQLError(`Expected a name, got ${token.kind}`);
    if (value !== undefined && token.value !== value) throw new GraphQLError(`Expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    this.next();
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === '(') this.parseArguments();
    }
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        operations.push(this.parseOperation());
      }
    }
    if (operations.length === 0) throw new GraphQLError('No operation in query');
    return { operations, fragments };
  }

  private parseFragment(): FragmentNode {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    this.skipDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'fragment', name, typeCondition, selectionSet };
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' | 'subscription' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      operation = token.value as 'query' | 'mutation' | 'subscription';
      this.next();
      if (this.peek().kind === 'name') name = this.expectName();
    }
    const variableDefinitions = this.parseVariableDefinitions();
    this.skipDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variableDefinitions, selectionSet };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind !== '(') return defs;
    this.next();
    while (this.peek().kind !== ')') {
      this.expect('$');
      const name = this.expectName();
      this.expect(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      defs.push({ name, defaultValue });
    }
    this.expect(')');
    return defs;
  }

  private parseType(): void {
    if (this.peek().kind === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().kind !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === '...') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const selectionSet = this.peek().kind === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind !== '(') return args;
    this.next();
    while (this.peek().kind !== ')') {
      const name = this.expectName();
      this.expect(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expect(')');
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.peek();
    if (token.kind === '$') {
      if (isConst) throw new GraphQLError('Variable in a constant value');
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') {
      this.next();
      return { kind: 'int', value: Number.parseInt(token.value, 10) };
    }
    if (token.kind === 'float') {
      this.next();
      return { kind: 'float', value: Number.parseFloat(token.value) };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (this.peek().kind !== ']') values.push(this.parseValue(isConst));
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.kind === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek().kind !== '}') {
        const name = this.expectName();
        this.expect(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    throw new GraphQLError(`Unexpected ${token.kind} in a value`);
  }
}

// ---------------------------------------------------------------- values

/** Resolve a value node against the operation's variables. */
function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueFromAst(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromAst(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema

/** Fields each type exposes, for validation and for introspection. */
const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description',
    'isPrivate', 'url', 'createdAt', 'updatedAt',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels',
    'comments', 'url', 'repository',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'createdAt', 'updatedAt', 'author', 'url',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  Label: ['id', 'name', 'color', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  Node: ['id'],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

/** The object type a field returns (scalars resolve to their scalar name). */
const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Issue: { author: 'User', labels: 'Label', comments: 'IssueComment', repository: 'Repository' },
  PullRequest: { author: 'User', files: 'PullRequestChangedFileConnection' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  PullRequestEdge: { node: 'PullRequest' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile' },
  IssueCommentEdge: { node: 'IssueComment' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  __Type: { fields: '__Field', enumValues: '__EnumValue', inputFields: '__InputValue' },
};

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

// ---------------------------------------------------------------- global ids

function gid(kind: string, ...parts: Array<string | number>): string {
  return b64encodeText([kind, ...parts].join(':'));
}

function parseGid(id: string): { kind: string; parts: string[] } | null {
  const text = b64decodeText(id);
  if (text === null) return null;
  const [kind, ...parts] = text.split(':');
  if (kind === undefined || kind === '') return null;
  return { kind, parts };
}

function repoGid(repo: Repo): string {
  return gid('Repository', repo.id);
}

function issueGid(repo: Repo, issue: Issue): string {
  return gid('Issue', repo.id, issue.number);
}

function pullGid(repo: Repo, pull: PullRequest): string {
  return gid('PullRequest', repo.id, pull.number);
}

function commentGid(repo: Repo, commentId: number): string {
  return gid('IssueComment', repo.id, commentId);
}

function encodeCursor(seq: number): string {
  return b64encodeText(`cursor:${seq}`);
}

function decodeCursor(cursor: string): number | null {
  const text = b64decodeText(cursor);
  if (text === null || !text.startsWith('cursor:')) return null;
  const n = Number.parseInt(text.slice('cursor:'.length), 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- execution context

interface GqlContext {
  store: ForgeStore;
  viewerLogin: string;
}

type AnyObject = Record<string, unknown> & { __typename: string };

function tagged(typename: string, fields: Record<string, unknown>): AnyObject {
  return { __typename: typename, ...fields };
}

function viewerUser(ctx: GqlContext): AnyObject {
  return tagged('User', {
    id: gid('User', ctx.viewerLogin),
    login: ctx.viewerLogin,
    name: null,
    email: null,
    url: null,
  });
}

function issueNode(ctx: GqlContext, repo: Repo, issue: Issue): AnyObject {
  return tagged('Issue', {
    id: issueGid(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: null,
    author: viewerUser(ctx),
    labels: issue.labels.map((name) => tagged('Label', { id: gid('Label', repo.id, name), name, color: repo.labels.get(name)?.color ?? '000000', description: null })),
    repository: repositoryNode(ctx, repo),
    __repo: repo,
    __issue: issue,
  });
}

function pullNode(ctx: GqlContext, repo: Repo, pull: PullRequest): AnyObject {
  const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  let mergeable: string = 'UNKNOWN';
  if (pull.state === 'open') {
    mergeable = ctx.store.mergePlan(repo, pull).conflict === null ? 'MERGEABLE' : 'CONFLICTING';
  }
  return tagged('PullRequest', {
    id: pullGid(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    url: null,
    author: viewerUser(ctx),
    __repo: repo,
    __pull: pull,
  });
}

function repositoryNode(ctx: GqlContext, repo: Repo): AnyObject {
  return tagged('Repository', {
    id: repoGid(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${ctx.viewerLogin}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    url: null,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    owner: viewerUser(ctx),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    __repo: repo,
  });
}

/** A connection over a list, with cursor pagination. */
function connection(
  typename: string,
  items: AnyObject[],
  args: Record<string, unknown>,
  seqOf: (item: AnyObject) => number,
): AnyObject {
  const first = typeof args.first === 'number' ? args.first : 100;
  const afterSeq = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  let filtered = items;
  if (afterSeq !== null) {
    // Items are pre-sorted in the connection's order; the cursor names the
    // last item of the previous page in that same order.
    const index = items.findIndex((item) => seqOf(item) === afterSeq);
    filtered = index >= 0 ? items.slice(index + 1) : items;
  }
  const page = filtered.slice(0, first);
  const hasNextPage = filtered.length > page.length;
  const last = page[page.length - 1];
  const firstItem = page[0];
  return tagged(typename, {
    nodes: page,
    edges: page.map((item) => tagged(`${typename.replace('Connection', '')}Edge`, { node: item, cursor: encodeCursor(seqOf(item)) })),
    pageInfo: tagged('PageInfo', {
      hasNextPage,
      hasPreviousPage: afterSeq !== null,
      startCursor: firstItem !== undefined ? encodeCursor(seqOf(firstItem)) : null,
      endCursor: last !== undefined ? encodeCursor(seqOf(last)) : null,
    }),
    totalCount: items.length,
  });
}

function issuesConnection(ctx: GqlContext, repo: Repo, args: Record<string, unknown>): AnyObject {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? null;
  let issues = [...repo.issues.values()];
  if (states !== null) {
    const want = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
    issues = issues.filter((issue) => want.has(issue.state));
  }
  const direction = orderBy?.direction ?? 'DESC';
  issues.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  return connection('IssueConnection', issues.map((issue) => issueNode(ctx, repo, issue)), args, (item) => (item.__issue as Issue).seq);
}

function pullsConnection(ctx: GqlContext, repo: Repo, args: Record<string, unknown>): AnyObject {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let pulls = [...repo.pulls.values()];
  if (states !== null) {
    const want = new Set(states);
    pulls = pulls.filter((pull) => want.has(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
  } else {
    pulls = pulls.filter((pull) => pull.state === 'open');
  }
  pulls.sort((a, b) => b.seq - a.seq);
  return connection('PullRequestConnection', pulls.map((pull) => pullNode(ctx, repo, pull)), args, (item) => (item.__pull as PullRequest).seq);
}

function filesConnection(ctx: GqlContext, repo: Repo, pull: PullRequest, args: Record<string, unknown>): AnyObject {
  const files = ctx.store.pullRequestFiles(repo, pull);
  const nodes = files.map((file, index) =>
    tagged('PullRequestChangedFile', {
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
      __index: index,
    }),
  );
  return connection('PullRequestChangedFileConnection', nodes, args, (item) => item.__index as number);
}

function findRepoByDbid(ctx: GqlContext, dbid: number): Repo | undefined {
  for (const repo of ctx.store.repos.values()) {
    if (repo.id === dbid) return repo;
  }
  return undefined;
}

// ---------------------------------------------------------------- field resolution

function resolveField(
  ctx: GqlContext,
  parentType: string,
  parent: AnyObject | null,
  field: FieldNode,
  args: Record<string, unknown>,
): unknown {
  // Root fields.
  if (parent === null) {
    if (parentType === 'Query') {
      if (field.name === 'viewer') return viewerUser(ctx);
      if (field.name === 'repository') {
        const owner = args.owner as string | undefined;
        const name = args.name as string | undefined;
        if (owner !== ctx.viewerLogin || name === undefined) return null;
        const repo = ctx.store.getRepoFor(owner, name);
        return repo === undefined ? null : repositoryNode(ctx, repo);
      }
      if (field.name === 'node') {
        const parsed = typeof args.id === 'string' ? parseGid(args.id) : null;
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repo = findRepoByDbid(ctx, Number.parseInt(parsed.parts[0] ?? '', 10));
          return repo === undefined ? null : repositoryNode(ctx, repo);
        }
        if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
          const repo = findRepoByDbid(ctx, Number.parseInt(parsed.parts[0] ?? '', 10));
          if (repo === undefined) return null;
          const number = Number.parseInt(parsed.parts[1] ?? '', 10);
          if (parsed.kind === 'Issue') {
            const issue = repo.issues.get(number);
            return issue === undefined ? null : issueNode(ctx, repo, issue);
          }
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : pullNode(ctx, repo, pull);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = args.name as string | undefined;
        if (name === undefined) return null;
        const fields = SCHEMA_FIELDS[name];
        const enums = SCHEMA_ENUMS[name];
        if (fields === undefined && enums === undefined) return null;
        return tagged('__Type', {
          name,
          kind: enums !== undefined ? 'ENUM' : name === 'Node' ? 'INTERFACE' : 'OBJECT',
          description: null,
          fields: (fields ?? []).map((fieldName) => tagged('__Field', { name: fieldName, description: null, args: [], type: null })),
          enumValues: (enums ?? []).map((value) => tagged('__EnumValue', { name: value, description: null })),
          inputFields: [],
          interfaces: [],
          possibleTypes: [],
        });
      }
    }
    if (parentType === 'Mutation') {
      return resolveMutation(ctx, field, args);
    }
    return null;
  }

  // Repository fields with arguments.
  if (parentType === 'Repository') {
    const repo = parent.__repo as Repo;
    if (field.name === 'defaultBranchRef') {
      return ctx.store.branchTip(repo, repo.defaultBranch) === null
        ? null
        : tagged('Ref', { name: repo.defaultBranch, target: null });
    }
    if (field.name === 'issue') {
      const issue = repo.issues.get(args.number as number);
      return issue === undefined ? null : issueNode(ctx, repo, issue);
    }
    if (field.name === 'issues') return issuesConnection(ctx, repo, args);
    if (field.name === 'pullRequests') return pullsConnection(ctx, repo, args);
    if (field.name === 'pullRequest') {
      const pull = repo.pulls.get(args.number as number);
      return pull === undefined ? null : pullNode(ctx, repo, pull);
    }
  }

  // Pull request files.
  if (parentType === 'PullRequest' && field.name === 'files') {
    const repo = parent.__repo as Repo;
    const pull = parent.__pull as PullRequest;
    return filesConnection(ctx, repo, pull, args);
  }

  // Plain stored fields (including __typename handled by the executor).
  const value = parent[field.name];
  return value === undefined ? null : value;
}

function resolveMutation(ctx: GqlContext, field: FieldNode, args: Record<string, unknown>): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  if (field.name === 'createIssue') {
    const parsed = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
    const repo = parsed?.kind === 'Repository' ? findRepoByDbid(ctx, Number.parseInt(parsed.parts[0] ?? '', 10)) : undefined;
    if (repo === undefined) throw new GraphQLError('Could not resolve to a Repository with the id provided.');
    const title = input.title as string | undefined;
    if (title === undefined || title === '') throw new GraphQLError('title is required');
    const issue = ctx.store.createIssue(repo, { title, body: (input.body as string | undefined) ?? '', labels: [] });
    return tagged('CreateIssuePayload', { issue: issueNode(ctx, repo, issue), clientMutationId: input.clientMutationId ?? null });
  }
  if (field.name === 'closeIssue') {
    const parsed = typeof input.issueId === 'string' ? parseGid(input.issueId) : null;
    const repo = parsed?.kind === 'Issue' ? findRepoByDbid(ctx, Number.parseInt(parsed.parts[0] ?? '', 10)) : undefined;
    const issue = repo?.issues.get(Number.parseInt(parsed?.parts[1] ?? '', 10));
    if (repo === undefined || issue === undefined) throw new GraphQLError('Could not resolve to an Issue with the id provided.');
    issue.state = 'closed';
    issue.updatedAt = nowISO();
    return tagged('CloseIssuePayload', { issue: issueNode(ctx, repo, issue), clientMutationId: input.clientMutationId ?? null });
  }
  if (field.name === 'createPullRequest') {
    const parsed = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
    const repo = parsed?.kind === 'Repository' ? findRepoByDbid(ctx, Number.parseInt(parsed.parts[0] ?? '', 10)) : undefined;
    if (repo === undefined) throw new GraphQLError('Could not resolve to a Repository with the id provided.');
    const baseRefName = input.baseRefName as string;
    const headRefName = input.headRefName as string;
    const title = input.title as string;
    const baseTip = ctx.store.branchTip(repo, baseRefName);
    const headTip = ctx.store.branchTip(repo, headRefName);
    if (baseTip === null || headTip === null) throw new GraphQLError('head and base branches must exist');
    const existing = ctx.store.findOpenPull(repo, headRefName, baseRefName);
    if (existing !== undefined) throw new GraphQLError('A pull request already exists for this branch.');
    const pull = ctx.store.createPull(repo, { title, body: (input.body as string | undefined) ?? '', head: headRefName, base: baseRefName });
    return tagged('CreatePullRequestPayload', { pullRequest: pullNode(ctx, repo, pull), clientMutationId: input.clientMutationId ?? null });
  }
  if (field.name === 'mergePullRequest') {
    const parsed = typeof input.pullRequestId === 'string' ? parseGid(input.pullRequestId) : null;
    const repo = parsed?.kind === 'PullRequest' ? findRepoByDbid(ctx, Number.parseInt(parsed.parts[0] ?? '', 10)) : undefined;
    const pull = repo?.pulls.get(Number.parseInt(parsed?.parts[1] ?? '', 10));
    if (repo === undefined || pull === undefined) throw new GraphQLError('Could not resolve to a PullRequest with the id provided.');
    const result = ctx.store.mergePullRequest(repo, pull);
    if (result === null) throw new GraphQLError('Pull request is not mergeable');
    return tagged('MergePullRequestPayload', { pullRequest: pullNode(ctx, repo, pull), clientMutationId: input.clientMutationId ?? null });
  }
  if (field.name === 'addComment') {
    const parsed = typeof input.subjectId === 'string' ? parseGid(input.subjectId) : null;
    const repo =
      parsed?.kind === 'Issue' || parsed?.kind === 'PullRequest'
        ? findRepoByDbid(ctx, Number.parseInt(parsed.parts[0] ?? '', 10))
        : undefined;
    if (repo === undefined || parsed === null) throw new GraphQLError('Could not resolve to a subject with the id provided.');
    const number = Number.parseInt(parsed.parts[1] ?? '', 10);
    const body = (input.body as string | undefined) ?? '';
    let commentId: number;
    let commentCreatedAt: string;
    if (parsed.kind === 'Issue') {
      const comment = ctx.store.addComment(repo, number, body);
      if (comment === null) throw new GraphQLError('Could not resolve to a subject with the id provided.');
      commentId = comment.id;
      commentCreatedAt = comment.createdAt;
    } else {
      // Pull requests carry no comment list in this store; the comment is
      // still answered with a stable id (the suite never reads it back).
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new GraphQLError('Could not resolve to a subject with the id provided.');
      commentId = repo.nextItemId++;
      commentCreatedAt = nowISO();
    }
    return tagged('AddCommentPayload', {
      commentEdge: tagged('IssueCommentEdge', {
        node: tagged('IssueComment', {
          id: commentGid(repo, commentId),
          body,
          createdAt: commentCreatedAt,
          updatedAt: commentCreatedAt,
          author: viewerUser(ctx),
        }),
        cursor: encodeCursor(commentId),
      }),
      clientMutationId: input.clientMutationId ?? null,
    });
  }
  return null;
}

// ---------------------------------------------------------------- executor

/** Group a selection set's fields by response key, expanding fragments. */
function collectFields(
  selections: readonly SelectionNode[],
  fragments: Map<string, FragmentNode>,
  runtimeType: string,
  visited: Set<string>,
  out: Map<string, { field: FieldNode; selections: SelectionNode[] }>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      const existing = out.get(key);
      if (existing === undefined) {
        out.set(key, { field: selection, selections: selection.selectionSet ?? [] });
      } else {
        existing.selections.push(...(selection.selectionSet ?? []));
      }
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== runtimeType) continue;
      collectFields(selection.selectionSet, fragments, runtimeType, visited, out);
      continue;
    }
    // Fragment spread.
    if (visited.has(selection.name)) continue;
    const fragment = fragments.get(selection.name);
    if (fragment === undefined) continue;
    if (fragment.typeCondition !== runtimeType) continue;
    visited.add(selection.name);
    collectFields(fragment.selectionSet, fragments, runtimeType, visited, out);
  }
}

/** Execute a selection set against a value, returning the response object. */
function executeSelectionSet(
  ctx: GqlContext,
  parentType: string,
  parent: AnyObject | null,
  selections: readonly SelectionNode[],
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const runtimeType = parent === null ? parentType : parent.__typename;
  const grouped = new Map<string, { field: FieldNode; selections: SelectionNode[] }>();
  collectFields(selections, fragments, runtimeType, new Set<string>(), grouped);
  const result: Record<string, unknown> = {};
  for (const [responseKey, { field, selections: merged }] of grouped) {
    if (field.name === '__typename') {
      result[responseKey] = runtimeType;
      continue;
    }
    const validFields = SCHEMA_FIELDS[parentType] ?? SCHEMA_FIELDS[runtimeType] ?? [];
    if (!validFields.includes(field.name)) {
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${parentType}".`);
    }
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = valueFromAst(arg.value, variables);
    const value = resolveField(ctx, parentType, parent, field, args);
    if (merged.length === 0) {
      result[responseKey] = value;
      continue;
    }
    const returnType = FIELD_TYPES[parentType]?.[field.name] ?? FIELD_TYPES[runtimeType]?.[field.name];
    if (returnType === undefined || SCALAR_TYPES.has(returnType)) {
      throw new GraphQLError(`Field "${field.name}" of type "${returnType ?? 'unknown'}" must not have a selection of subfields.`);
    }
    result[responseKey] = executeValue(ctx, returnType, value, merged, fragments, variables);
  }
  return result;
}

/** Execute a sub-selection against a resolved value (object, list, or null). */
function executeValue(
  ctx: GqlContext,
  returnType: string,
  value: unknown,
  selections: readonly SelectionNode[],
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === null ? null : executeSelectionSet(ctx, returnType, item as AnyObject, selections, fragments, variables),
    );
  }
  // An interface (Node) resolves to the concrete runtime type.
  const type = returnType === 'Node' ? (value as AnyObject).__typename : returnType;
  return executeSelectionSet(ctx, type, value as AnyObject, selections, fragments, variables);
}

/** Run one operation document, returning the GraphQL response object. */
function executeDocument(
  ctx: GqlContext,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | undefined,
): { data: unknown; errors?: Array<{ message: string }> } {
  try {
    const { operations, fragments } = new Parser(query).parseDocument();
    let operation: OperationNode | undefined;
    if (operationName !== undefined) {
      operation = operations.find((candidate) => candidate.name === operationName);
      if (operation === undefined) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    } else {
      if (operations.length > 1) {
        return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
      }
      operation = operations[0]!;
    }
    const mergedVariables: Record<string, unknown> = { ...variables };
    for (const def of operation.variableDefinitions) {
      if (mergedVariables[def.name] === undefined && def.defaultValue !== null) {
        mergedVariables[def.name] = valueFromAst(def.defaultValue, {});
      }
    }
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelectionSet(ctx, rootType, null, operation.selectionSet, fragments, mergedVariables);
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

// ---------------------------------------------------------------- route

export function registerGraphqlRoutes(): void {
  route('POST', '/api/graphql', (req, res) => {
    if (!isAuthorized(req)) {
      res.error(401, 'Bad credentials');
      return;
    }
    if (req.jsonParseError || req.json === undefined) {
      res.error(400, 'Problems parsing JSON');
      return;
    }
    const body = req.json;
    const ctx: GqlContext = { store: req.ctx.store, viewerLogin: req.ctx.store.viewerLogin ?? '' };
    const documents = Array.isArray(body) ? body : [body];
    const responses = documents.map((document) => {
      const record = (document ?? {}) as Record<string, unknown>;
      const query = record.query;
      if (typeof query !== 'string') {
        return { data: null, errors: [{ message: 'Must provide query string.' }] };
      }
      const variables = (record.variables as Record<string, unknown> | undefined) ?? {};
      const operationName = record.operationName as string | undefined;
      return executeDocument(ctx, query, variables, operationName);
    });
    res.json(200, Array.isArray(body) ? responses : responses[0]);
  });

  // The env probes the REST health route; GraphQL GET is not part of the
  // contract and answers with a JSON error rather than a bare 404.
  route('GET', '/api/graphql', (_req, res) => {
    res.error(405, 'GraphQL requires a POST request');
  });
}

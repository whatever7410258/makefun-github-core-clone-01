/**
 * MCP over JSON-RPC 2.0 Streamable HTTP at /mcp (plain JSON answers, no SSE).
 *
 * - server/discover answers the modern handshake (revision 2026-07-28 plus
 *   legacy revisions); initialize is the legacy fallback.
 * - tools/list returns the six tools the suite requires, built once at
 *   startup so two answers are byte-identical.
 * - tools/call answers with content + structuredContent + isError, echoing
 *   the request id. Unknown tools are -32601, missing required arguments
 *   are -32602, tool execution errors are isError results — never a 500.
 * - A non-JSON body is HTTP 400 with a -32700 error; a notification is
 *   HTTP 202 with an empty body; any request without a valid bearer token
 *   is 401.
 */

import { isAuthorized, route, type RequestView, type ResponseView } from './server.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string }>;
    required: string[];
  };
}

/** Built once at module load so tools/list answers are byte-identical. */
const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
        owner: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

type JsonRpcId = string | number | null;

interface ToolOutcome {
  ok: boolean;
  value: unknown;
  message?: string;
}

function runTool(req: RequestView, name: string, args: Record<string, unknown>): ToolOutcome {
  const store = req.ctx.store;
  const owner = (args.owner as string | undefined) ?? store.viewerLogin ?? '';
  const repoName = args.repo as string | undefined;

  if (name === 'create_repo') {
    const repoNameArg = args.name as string | undefined;
    if (repoNameArg === undefined || repoNameArg === '') return { ok: false, value: null, message: 'name is required' };
    store.learnViewer(owner);
    const existing = store.getRepoFor(owner, repoNameArg);
    if (existing !== undefined) return { ok: false, value: null, message: 'Repository already exists' };
    const repo = store.createRepo(repoNameArg, {
      description: (args.description as string | undefined) ?? '',
      private: (args.private as boolean | undefined) ?? false,
    });
    return { ok: true, value: repoJson(store, repo, req) };
  }

  if (repoName === undefined) return { ok: false, value: null, message: 'repo is required' };
  const repo = store.getRepoFor(owner, repoName);
  if (repo === undefined) return { ok: false, value: null, message: 'Not Found' };

  if (name === 'get_repo') {
    return { ok: true, value: repoJson(store, repo, req) };
  }
  if (name === 'create_issue') {
    const title = args.title as string | undefined;
    if (title === undefined || title === '') return { ok: false, value: null, message: 'title is required' };
    const issue = store.createIssue(repo, { title, body: (args.body as string | undefined) ?? '' });
    return { ok: true, value: issueJson(store, repo, issue, req) };
  }
  if (name === 'list_issues') {
    const state = (args.state as string | undefined) ?? 'open';
    const issues = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => a.seq - b.seq)
      .map((issue) => issueJson(store, repo, issue, req));
    return { ok: true, value: { issues } };
  }
  if (name === 'create_pull_request') {
    const title = args.title as string | undefined;
    const head = args.head as string | undefined;
    const base = args.base as string | undefined;
    if (title === undefined || head === undefined || base === undefined) {
      return { ok: false, value: null, message: 'title, head and base are required' };
    }
    const headTip = store.branchTip(repo, head);
    const baseTip = store.branchTip(repo, base);
    if (headTip === null || baseTip === null) {
      return { ok: false, value: null, message: 'head and base branches must exist' };
    }
    const existing = store.findOpenPull(repo, head, base);
    if (existing !== undefined) return { ok: false, value: null, message: 'A pull request already exists for this branch.' };
    const pull = store.createPull(repo, { title, body: (args.body as string | undefined) ?? '', head, base });
    return { ok: true, value: pullJson(store, repo, pull, req) };
  }
  if (name === 'merge_pull_request') {
    const number = args.pull_number as number | undefined;
    if (typeof number !== 'number') return { ok: false, value: null, message: 'pull_number is required' };
    const pull = repo.pulls.get(number);
    if (pull === undefined) return { ok: false, value: null, message: 'Not Found' };
    if (pull.state !== 'open') return { ok: false, value: null, message: 'Pull request is not open' };
    const sha = store.mergePullRequest(repo, pull);
    if (sha === null) return { ok: false, value: null, message: 'Pull request is not mergeable' };
    return {
      ok: true,
      value: { merged: true, sha, number: pull.number, state: 'closed', message: 'Pull Request successfully merged' },
    };
  }
  return { ok: false, value: null, message: `Unknown tool: ${name}` };
}

function rpcResult(res: ResponseView, id: JsonRpcId, result: unknown): void {
  res.json(200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ResponseView, id: JsonRpcId, code: number, message: string): void {
  res.json(200, { jsonrpc: '2.0', id, error: { code, message } });
}

function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

export function registerMcpRoutes(): void {
  route('POST', '/mcp', (req, res) => {
    if (!isAuthorized(req)) {
      res.error(401, 'Bad credentials');
      return;
    }
    const raw = req.body.toString('utf8');
    let request: unknown;
    try {
      request = JSON.parse(raw);
    } catch {
      // A non-JSON body is a parse error; recover the id when it is visible.
      const match = raw.match(/"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/);
      let id: JsonRpcId = null;
      if (match !== null) {
        try {
          id = JSON.parse(match[1]!) as JsonRpcId;
        } catch {
          id = null;
        }
      }
      res.json(400, { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      res.json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const record = request as Record<string, unknown>;
    const hasId = 'id' in record && record.id !== undefined && record.id !== null;
    const id = (record.id as JsonRpcId) ?? null;
    const method = record.method as string | undefined;
    const params = (record.params as Record<string, unknown> | undefined) ?? {};

    // Notifications carry no id and are acknowledged with an empty 202.
    if (!hasId) {
      res.raw(202, 'application/json', Buffer.alloc(0));
      return;
    }
    if (typeof method !== 'string' || method === '') {
      rpcError(res, id, -32600, 'Invalid Request: method is required');
      return;
    }

    if (method === 'server/discover') {
      rpcResult(res, id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
      });
      return;
    }
    if (method === 'initialize') {
      rpcResult(res, id, {
        protocolVersion: (params.protocolVersion as string | undefined) ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
      });
      return;
    }
    if (method === 'ping') {
      rpcResult(res, id, {});
      return;
    }
    if (method === 'tools/list') {
      rpcResult(res, id, { tools: TOOLS });
      return;
    }
    if (method === 'tools/call') {
      const name = params.name as string | undefined;
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      if (name === undefined || name === '') {
        rpcError(res, id, -32602, 'Invalid params: tool name is required');
        return;
      }
      const tool = TOOL_BY_NAME.get(name);
      if (tool === undefined) {
        rpcError(res, id, -32601, `Method not found: ${name}`);
        return;
      }
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null) {
          rpcError(res, id, -32602, `Invalid params: missing required argument "${required}"`);
          return;
        }
      }
      const outcome = runTool(req, name, args);
      if (!outcome.ok) {
        const message = outcome.message ?? 'Tool call failed';
        rpcResult(res, id, {
          content: [{ type: 'text', text: message }],
          structuredContent: { error: message },
          isError: true,
        });
        return;
      }
      rpcResult(res, id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
        structuredContent: outcome.value,
        isError: false,
      });
      return;
    }
    rpcError(res, id, -32601, `Method not found: ${method}`);
  });
}

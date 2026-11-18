/**
 * The REST v3 API under /api/v3: repositories, branches, commits, git refs,
 * contents, labels, issues, comments and pull requests.
 *
 * Every reply is application/json with a non-empty X-GitHub-Request-Id;
 * errors carry a JSON {message} body; unknown routes are 404 JSON; a
 * malformed JSON body is 400. Bearer auth from MAKEFUN_SHOP_TOKEN: a
 * missing or wrong token is 401, and a repo under another owner is 404,
 * never 403.
 */

import type { ForgeStore, Issue, PullRequest, Repo } from './store.ts';
import { isAuthorized, requestOrigin, route, type RequestView, type ResponseView } from './server.ts';
import { b64decode, b64encode, isOid, lower } from './util.ts';
import { lookupPath, parseTree } from './gitobj.ts';

type Handler = (req: RequestView, res: ResponseView, store: ForgeStore) => Promise<void> | void;

const VIEWER_ID = 1000;

/** Register a REST route with auth + malformed-JSON handling. */
function rest(method: string, path: string, handler: Handler): void {
  route(method, path, (req, res) => {
    if (!isAuthorized(req)) {
      res.error(401, 'Bad credentials');
      return;
    }
    if (req.jsonParseError) {
      res.error(400, 'Problems parsing JSON');
      return;
    }
    return handler(req, res, req.ctx.store);
  });
}

/** The request's JSON body as a record ({} when absent). */
function bodyOf(req: RequestView): Record<string, unknown> {
  if (req.json !== undefined && req.json !== null && typeof req.json === 'object' && !Array.isArray(req.json)) {
    return req.json as Record<string, unknown>;
  }
  return {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Parse per_page/page query params (GitHub defaults: per_page 30, page 1). */
function pageParams(req: RequestView): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(req.query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(req.query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, perPageRaw) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

/** A GitHub-style Link header for a paged list. */
function linkHeader(req: RequestView, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const origin = requestOrigin(req);
  const base = `${origin}${req.path}`;
  const other = new URLSearchParams(req.queryString);
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(other);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `<${base}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`${urlFor(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${urlFor(page - 1)}; rel="prev"`);
  links.push(`${urlFor(1)}; rel="first"`);
  links.push(`${urlFor(totalPages)}; rel="last"`);
  return links.join(', ');
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

/** Send a paged list with a Link header when there is more than one page. */
function sendList(req: RequestView, res: ResponseView, items: readonly unknown[]): void {
  const { perPage, page } = pageParams(req);
  const link = linkHeader(req, page, perPage, items.length);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  res.json(200, paginate(items, page, perPage), headers);
}

function ownerObject(store: ForgeStore): { login: string; id: number; type: string } {
  return { login: store.viewerLogin ?? '', id: VIEWER_ID, type: 'User' };
}

export function repoJson(store: ForgeStore, repo: Repo, req: RequestView): Record<string, unknown> {
  const owner = store.viewerLogin ?? '';
  const origin = requestOrigin(req);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: ownerObject(store),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
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
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    html_url: `${origin}/${owner}/${repo.name}`,
    clone_url: `${origin}/${owner}/${repo.name}.git`,
    git_url: `${origin}/${owner}/${repo.name}.git`,
    ssh_url: `git@${origin.replace(/^https?:\/\//, '')}:${owner}/${repo.name}.git`,
    url: `${origin}/api/v3/repos/${owner}/${repo.name}`,
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(store: ForgeStore, repo: Repo, issue: Issue, req: RequestView): Record<string, unknown> {
  const owner = store.viewerLogin ?? '';
  const origin = requestOrigin(req);
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: ownerObject(store),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    html_url: `${origin}/${owner}/${repo.name}/issues/${issue.number}`,
    url: `${origin}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `${origin}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

export function pullJson(store: ForgeStore, repo: Repo, pull: PullRequest, req: RequestView): Record<string, unknown> {
  const owner = store.viewerLogin ?? '';
  const origin = requestOrigin(req);
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = store.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: ownerObject(store),
    labels: [],
    assignee: null,
    assignees: [],
    milestone: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? store.pullRequestMergeable(repo, pull) : null,
    mergeable_state: pull.state === 'open' ? (store.pullRequestMergeable(repo, pull) ? 'clean' : 'dirty') : 'unknown',
    merged_by: pull.merged ? ownerObject(store) : null,
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${owner}:${pull.headRef}`,
      repo: { id: repo.id, name: repo.name, full_name: `${owner}/${repo.name}` },
      user: ownerObject(store),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${owner}:${pull.baseRef}`,
      repo: { id: repo.id, name: repo.name, full_name: `${owner}/${repo.name}` },
      user: ownerObject(store),
    },
    author_association: 'OWNER',
    draft: false,
    html_url: `${origin}/${owner}/${repo.name}/pull/${pull.number}`,
    url: `${origin}/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Parse an author line `Name <email> ts +0000` into its parts. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: '' };
  const ts = Number(match[3]);
  return {
    name: match[1] ?? '',
    email: match[2] ?? '',
    date: Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : '',
  };
}

/** Resolve a repo from the route params, learning the viewer; 404 when foreign or missing. */
function resolveRepo(req: RequestView, res: ResponseView, store: ForgeStore): Repo | null {
  const owner = req.params[0] ?? '';
  const name = req.params[1] ?? '';
  const repo = store.getRepoFor(owner, name);
  if (repo === undefined) {
    res.error(404, 'Not Found');
    return null;
  }
  return repo;
}

/** Parse a route number param; null when it is not a positive integer. */
function routeNumber(req: RequestView, index: number): number | null {
  const raw = req.params[index] ?? '';
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return value > 0 ? value : null;
}

export function registerRestRoutes(): void {
  // -- root + meta + user -------------------------------------------------
  rest('GET', '/api/v3', (req, res) => {
    res.json(
      200,
      {
        current_user_url: `${requestOrigin(req)}/api/v3/user`,
        authorizations_url: `${requestOrigin(req)}/api/v3/authorizations`,
        repository_url: `${requestOrigin(req)}/api/v3/repos/{owner}/{repo}`,
        user_url: `${requestOrigin(req)}/api/v3/users/{user}`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  });
  rest('GET', '/api/v3/meta', (_req, res) => {
    res.json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  });
  rest('GET', '/api/v3/user', (req, res) => {
    const store = req.ctx.store;
    const login = store.viewerLogin ?? '';
    res.json(200, {
      login,
      id: VIEWER_ID,
      node_id: `U_${VIEWER_ID}`,
      avatar_url: '',
      type: 'User',
      site_admin: false,
      name: login,
      email: login === '' ? '' : `${login}@example.invalid`,
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    });
  });

  // -- user repos ---------------------------------------------------------
  rest('POST', '/api/v3/user/repos', (req, res) => {
    const store = req.ctx.store;
    const body = bodyOf(req);
    const name = str(body.name);
    if (name === '' || name.includes('/') || /[\s\u0000-\u001f]/.test(name)) {
      res.error(422, 'name is required and must not contain a slash or whitespace');
      return;
    }
    if (store.getRepo(name) !== undefined) {
      res.error(422, 'Repository already exists');
      return;
    }
    const repo = store.createRepo(name, {
      description: str(body.description),
      private: bool(body.private, false),
    });
    res.json(201, repoJson(store, repo, req));
  });
  rest('GET', '/api/v3/user/repos', (req, res) => {
    const store = req.ctx.store;
    sendList(req, res, store.listRepos().map((repo) => repoJson(store, repo, req)));
  });

  // -- one repo -----------------------------------------------------------
  rest('GET', '/api/v3/repos/:owner/:repo', (req, res) => {
    const repo = resolveRepo(req, res, req.ctx.store);
    if (repo === null) return;
    res.json(200, repoJson(req.ctx.store, repo, req));
  });
  rest('PATCH', '/api/v3/repos/:owner/:repo', (req, res) => {
    const repo = resolveRepo(req, res, req.ctx.store);
    if (repo === null) return;
    const body = bodyOf(req);
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.private = body.private;
    if (typeof body.default_branch === 'string' && body.default_branch !== '' && req.ctx.store.branchTip(repo, body.default_branch) !== null) {
      repo.defaultBranch = body.default_branch;
    }
    res.json(200, repoJson(req.ctx.store, repo, req));
  });
  rest('DELETE', '/api/v3/repos/:owner/:repo', (req, res) => {
    const store = req.ctx.store;
    const owner = req.params[0] ?? '';
    const name = req.params[1] ?? '';
    if (store.getRepoFor(owner, name) === undefined) {
      res.error(404, 'Not Found');
      return;
    }
    store.deleteRepo(name);
    res.empty(204);
  });

  // -- branches + commits ---------------------------------------------------
  rest('GET', '/api/v3/repos/:owner/:repo/branches', (req, res) => {
    const repo = resolveRepo(req, res, req.ctx.store);
    if (repo === null) return;
    res.json(
      200,
      req.ctx.store.branches(repo).map((branch) => ({
        name: branch.name,
        commit: { sha: branch.sha },
        protected: false,
      })),
    );
  });
  rest('GET', '/api/v3/repos/:owner/:repo/branches/*', (req, res) => {
    const repo = resolveRepo(req, res, req.ctx.store);
    if (repo === null) return;
    const branch = req.params[2] ?? '';
    const tip = req.ctx.store.branchTip(repo, branch);
    if (tip === null) {
      res.error(404, 'Branch not found');
      return;
    }
    res.json(200, { name: branch, commit: { sha: tip }, protected: false });
  });
  rest('GET', '/api/v3/repos/:owner/:repo/commits', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const ref = req.query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (tip === null) {
      res.error(404, 'No commit found for SHA: ' + ref);
      return;
    }
    const commits = store.listCommits(repo, tip).map((commit) => {
      const author = parseIdentity(commit.author);
      const committer = parseIdentity(commit.committer);
      return {
        sha: commit.sha,
        node_id: `C_${commit.sha}`,
        commit: {
          message: commit.message,
          author,
          committer,
          tree: { sha: store.treeOf(repo, commit.sha) ?? '' },
        },
        author: ownerObject(store),
        committer: ownerObject(store),
        parents: commit.parents.map((sha) => ({ sha })),
      };
    });
    sendList(req, res, commits);
  });

  // -- git refs -----------------------------------------------------------
  rest('GET', '/api/v3/repos/:owner/:repo/git/refs', (req, res) => {
    const repo = resolveRepo(req, res, req.ctx.store);
    if (repo === null) return;
    const refs = [...repo.refs.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([ref, sha]) => ({
        ref,
        object: { sha, type: req.ctx.store.getObject(repo, sha)?.type ?? 'commit' },
      }));
    res.json(200, refs);
  });
  rest('GET', '/api/v3/repos/:owner/:repo/git/refs/*', (req, res) => {
    const repo = resolveRepo(req, res, req.ctx.store);
    if (repo === null) return;
    const rest = req.params[2] ?? '';
    const ref = `refs/${rest}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) {
      res.error(404, 'Not Found');
      return;
    }
    res.json(200, { ref, object: { sha, type: req.ctx.store.getObject(repo, sha)?.type ?? 'commit' } });
  });
  rest('POST', '/api/v3/repos/:owner/:repo/git/refs', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const body = bodyOf(req);
    const ref = str(body.ref);
    const sha = lower(body.sha);
    if (!ref.startsWith('refs/') || ref.length <= 5) {
      res.error(422, 'ref must start with refs/');
      return;
    }
    if (!isOid(sha) || store.getObject(repo, sha) === undefined) {
      res.error(422, 'Object does not exist');
      return;
    }
    if (repo.refs.has(ref)) {
      res.error(422, 'Reference already exists');
      return;
    }
    repo.refs.set(ref, sha);
    res.json(201, { ref, object: { sha, type: store.getObject(repo, sha)?.type ?? 'commit' } });
  });

  // -- contents -----------------------------------------------------------
  const getContents = (req: RequestView, res: ResponseView): void => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const path = req.params[2] ?? '';
    const ref = req.query.get('ref') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, ref);
    if (tip === null) {
      res.error(404, 'Not Found');
      return;
    }
    const treeOid = store.treeOf(repo, tip);
    if (treeOid === null) {
      res.error(404, 'Not Found');
      return;
    }
    const segments = path.split('/').filter((segment) => segment !== '');
    const listDir = (dirOid: string, dirPath: string): Array<Record<string, unknown>> | null => {
      const object = store.getObject(repo, dirOid);
      if (!object || object.type !== 'tree') return null;
      let entries;
      try {
        entries = parseTree(object.data);
      } catch {
        return null;
      }
      return entries.map((entry) => {
        const isDir = entry.mode === '40000';
        const blob = isDir ? undefined : store.getObject(repo, entry.oid);
        return {
          type: isDir ? 'dir' : 'file',
          name: entry.name,
          path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
          sha: entry.oid,
          size: isDir ? null : (blob?.data.length ?? 0),
          url: '',
        };
      });
    };
    if (segments.length === 0) {
      const entries = listDir(treeOid, '');
      if (entries === null) {
        res.error(404, 'Not Found');
        return;
      }
      res.json(200, entries);
      return;
    }
    let found;
    try {
      found = lookupPath(store.lookup(repo), treeOid, segments);
    } catch {
      found = null;
    }
    if (found === null) {
      res.error(404, 'Not Found');
      return;
    }
    if (found.isTree) {
      const entries = listDir(found.oid, path);
      if (entries === null) {
        res.error(404, 'Not Found');
        return;
      }
      res.json(200, entries);
      return;
    }
    const blob = store.getObject(repo, found.oid);
    if (!blob || blob.type !== 'blob') {
      res.error(404, 'Not Found');
      return;
    }
    res.json(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: segments[segments.length - 1],
      path,
      content: b64encode(blob.data),
      sha: found.oid,
    });
  };
  rest('GET', '/api/v3/repos/:owner/:repo/contents', getContents);
  rest('GET', '/api/v3/repos/:owner/:repo/contents/*', getContents);

  rest('PUT', '/api/v3/repos/:owner/:repo/contents/*', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const path = req.params[2] ?? '';
    if (path === '') {
      res.error(422, 'path is required');
      return;
    }
    const body = bodyOf(req);
    const contentB64 = str(body.content);
    if (contentB64 === '') {
      res.error(422, 'content is required');
      return;
    }
    const content = b64decode(contentB64);
    if (content === null) {
      res.error(422, 'content is not valid base64');
      return;
    }
    const branch = str(body.branch) !== '' ? str(body.branch) : repo.defaultBranch;
    const message = str(body.message) !== '' ? str(body.message) : `Update ${path}`;
    const existing = store.fileAt(repo, branch, path);
    const givenSha = lower(body.sha);
    if (existing !== null) {
      if (givenSha === '' || givenSha !== lower(existing.oid)) {
        res.error(409, 'sha does not match the current file');
        return;
      }
    }
    const { commitSha, blobSha } = store.commitFile(repo, { branch, path, content, message });
    const status = existing === null ? 201 : 200;
    const segments = path.split('/').filter((segment) => segment !== '');
    res.json(status, {
      content: {
        name: segments[segments.length - 1] ?? path,
        path,
        sha: blobSha,
        size: content.length,
        encoding: 'base64',
        content: b64encode(content),
        type: 'file',
      },
      commit: {
        sha: commitSha,
        message,
        author: { name: 'Forge', email: 'forge@localhost' },
        committer: { name: 'Forge', email: 'forge@localhost' },
      },
    });
  });

  rest('DELETE', '/api/v3/repos/:owner/:repo/contents/*', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const path = req.params[2] ?? '';
    const body = bodyOf(req);
    const branch = str(body.branch) !== '' ? str(body.branch) : repo.defaultBranch;
    const message = str(body.message) !== '' ? str(body.message) : `Delete ${path}`;
    const existing = store.fileAt(repo, branch, path);
    if (existing === null) {
      res.error(404, 'Not Found');
      return;
    }
    const givenSha = lower(body.sha);
    if (givenSha === '' || givenSha !== lower(existing.oid)) {
      res.error(409, 'sha does not match the current file');
      return;
    }
    const { commitSha } = store.commitFile(repo, { branch, path, content: null, message });
    res.json(200, { content: null, commit: { sha: commitSha, message } });
  });

  // -- labels -------------------------------------------------------------
  rest('GET', '/api/v3/repos/:owner/:repo/labels', (req, res) => {
    const repo = resolveRepo(req, res, req.ctx.store);
    if (repo === null) return;
    res.json(200, [...repo.labels.values()].map(labelJson));
  });
  rest('POST', '/api/v3/repos/:owner/:repo/labels', (req, res) => {
    const repo = resolveRepo(req, res, req.ctx.store);
    if (repo === null) return;
    const body = bodyOf(req);
    const name = str(body.name);
    if (name === '') {
      res.error(422, 'name is required');
      return;
    }
    if (repo.labels.has(name)) {
      res.error(422, 'Label already exists');
      return;
    }
    const label = { name, color: str(body.color) !== '' ? str(body.color) : 'ededed', description: str(body.description) };
    repo.labels.set(name, label);
    res.json(201, labelJson(label));
  });

  // -- issues -------------------------------------------------------------
  const parseLabels = (value: unknown): string[] | null => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') out.push(entry);
      else if (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string') {
        out.push((entry as Record<string, unknown>).name as string);
      } else return null;
    }
    return out;
  };

  rest('POST', '/api/v3/repos/:owner/:repo/issues', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const body = bodyOf(req);
    const title = str(body.title);
    if (title === '') {
      res.error(422, 'title is required');
      return;
    }
    const labels = parseLabels(body.labels);
    if (labels === null) {
      res.error(422, 'labels must be an array of label names');
      return;
    }
    for (const name of labels) {
      if (!repo.labels.has(name)) {
        res.error(422, `Label "${name}" does not exist`);
        return;
      }
    }
    const issue = store.createIssue(repo, { title, body: str(body.body), labels });
    res.json(201, issueJson(store, repo, issue, req));
  });
  rest('GET', '/api/v3/repos/:owner/:repo/issues', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const state = (req.query.get('state') ?? 'open').toLowerCase();
    const direction = (req.query.get('direction') ?? 'desc').toLowerCase();
    let issues = [...repo.issues.values()];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    sendList(req, res, issues.map((issue) => issueJson(store, repo, issue, req)));
  });
  rest('GET', '/api/v3/repos/:owner/:repo/issues/:number', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const number = routeNumber(req, 2);
    const issue = number === null ? undefined : repo.issues.get(number);
    if (issue === undefined) {
      res.error(404, 'Not Found');
      return;
    }
    res.json(200, issueJson(store, repo, issue, req));
  });
  rest('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const number = routeNumber(req, 2);
    const issue = number === null ? undefined : repo.issues.get(number);
    if (issue === undefined) {
      res.error(404, 'Not Found');
      return;
    }
    const body = bodyOf(req);
    if (typeof body.title === 'string' && body.title !== '') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
    if (body.labels !== undefined) {
      const labels = parseLabels(body.labels);
      if (labels === null) {
        res.error(422, 'labels must be an array of label names');
        return;
      }
      for (const name of labels) {
        if (!repo.labels.has(name)) {
          res.error(422, `Label "${name}" does not exist`);
          return;
        }
      }
      issue.labels = labels;
    }
    res.json(200, issueJson(store, repo, issue, req));
  });

  // -- issue comments -------------------------------------------------------
  rest('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const number = routeNumber(req, 2);
    const issue = number === null ? undefined : repo.issues.get(number);
    if (issue === undefined) {
      res.error(404, 'Not Found');
      return;
    }
    const body = bodyOf(req);
    const text = str(body.body);
    if (text === '') {
      res.error(422, 'body is required');
      return;
    }
    const comment = {
      id: repo.nextItemId++,
      body: text,
      createdAt: issue.createdAt,
      updatedAt: issue.createdAt,
    };
    issue.comments.push(comment);
    res.json(201, commentJson(req, store, repo, issue, comment));
  });
  rest('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const number = routeNumber(req, 2);
    const issue = number === null ? undefined : repo.issues.get(number);
    if (issue === undefined) {
      res.error(404, 'Not Found');
      return;
    }
    sendList(req, res, issue.comments.map((comment) => commentJson(req, store, repo, issue, comment)));
  });

  // -- pull requests --------------------------------------------------------
  rest('POST', '/api/v3/repos/:owner/:repo/pulls', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const body = bodyOf(req);
    const title = str(body.title);
    let head = str(body.head);
    let base = str(body.base);
    // GitHub accepts "owner:branch" for forks; this forge is single-user.
    if (head.includes(':')) head = head.split(':').pop() ?? head;
    if (base.includes(':')) base = base.split(':').pop() ?? base;
    if (title === '') {
      res.error(422, 'title is required');
      return;
    }
    if (head === '' || base === '') {
      res.error(422, 'head and base are required');
      return;
    }
    if (store.branchTip(repo, head) === null) {
      res.error(422, `Head branch "${head}" does not exist`);
      return;
    }
    if (store.branchTip(repo, base) === null) {
      res.error(422, `Base branch "${base}" does not exist`);
      return;
    }
    if (store.findOpenPull(repo, head, base) !== undefined) {
      res.error(422, 'A pull request already exists for these branches');
      return;
    }
    const pull = store.createPull(repo, { title, body: str(body.body), head, base });
    res.json(201, pullJson(store, repo, pull, req));
  });
  rest('GET', '/api/v3/repos/:owner/:repo/pulls', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const state = (req.query.get('state') ?? 'open').toLowerCase();
    let pulls = [...repo.pulls.values()];
    if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
    else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
    pulls.sort((a, b) => b.seq - a.seq);
    sendList(req, res, pulls.map((pull) => pullJson(store, repo, pull, req)));
  });
  rest('GET', '/api/v3/repos/:owner/:repo/pulls/:number', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const number = routeNumber(req, 2);
    const pull = number === null ? undefined : repo.pulls.get(number);
    if (pull === undefined) {
      res.error(404, 'Not Found');
      return;
    }
    res.json(200, pullJson(store, repo, pull, req));
  });
  rest('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const number = routeNumber(req, 2);
    const pull = number === null ? undefined : repo.pulls.get(number);
    if (pull === undefined) {
      res.error(404, 'Not Found');
      return;
    }
    const files = store.pullRequestFiles(repo, pull).map((file) => ({
      sha: '',
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    }));
    res.json(200, files);
  });
  rest('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', (req, res) => {
    const store = req.ctx.store;
    const repo = resolveRepo(req, res, store);
    if (repo === null) return;
    const number = routeNumber(req, 2);
    const pull = number === null ? undefined : repo.pulls.get(number);
    if (pull === undefined) {
      res.error(404, 'Not Found');
      return;
    }
    if (pull.state !== 'open') {
      res.error(405, 'Pull request is already closed');
      return;
    }
    const plan = store.mergePlan(repo, pull);
    if (plan.conflict !== null) {
      res.error(405, `Merge conflict in ${plan.conflict}`);
      return;
    }
    const sha = store.mergePullRequest(repo, pull);
    if (sha === null) {
      res.error(405, 'Pull request cannot be merged');
      return;
    }
    res.json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
  });
}

function commentJson(
  req: RequestView,
  store: ForgeStore,
  repo: Repo,
  issue: Issue,
  comment: { id: number; body: string; createdAt: string; updatedAt: string },
): Record<string, unknown> {
  const owner = store.viewerLogin ?? '';
  const origin = requestOrigin(req);
  return {
    id: comment.id,
    node_id: `IC_${repo.id}_${comment.id}`,
    body: comment.body,
    user: ownerObject(store),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `${origin}/${owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${origin}/api/v3/repos/${owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

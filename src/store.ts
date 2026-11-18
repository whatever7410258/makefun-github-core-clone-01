/**
 * The forge's store: everything lives in memory, keyed for the hot paths.
 *
 * One user owns every repository: the token owner. The server learns that
 * owner's login from the first owner it sees in a repo-scoped path (the
 * suite always addresses its own repositories by that login); a repo under
 * any other owner is a 404, never a 403. Repository names are unique across
 * the forge (the suite never creates the same name under two owners).
 *
 * Issues and pull requests share one numbering sequence per repository, as
 * on GitHub. All timestamps come from the trial's fixed "now".
 */

import {
  buildCommit,
  buildTree,
  collectReachable,
  flattenTree,
  hashObject,
  isAncestor,
  lookupPath,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { ZERO_OID, countLines, isOid, nowEpochSec, nowISO } from './util.ts';

export const DEFAULT_BRANCH = 'main';
/** The identity REST-created and merge commits carry (fixed: the suite never reads it). */
export const FORGE_IDENTITY = 'Forge <forge@localhost>';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  /** Creation order within the repo (timestamps are all the trial's "now"). */
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  /** Next shared issue/PR number. */
  nextNumber: number;
  /** Next REST numeric id for issues/PRs/comments in this repo. */
  nextItemId: number;
  /** Creation order (for stable list pagination). */
  seq: number;
}

export interface DiffFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export class ForgeStore {
  /** Repos by name (names are unique across the forge). */
  readonly repos = new Map<string, Repo>();
  /** The token owner's login, learned from the first repo-scoped path. */
  viewerLogin: string | null = null;
  private nextRepoId = 1;
  private nextRepoSeq = 1;

  /** Learn the viewer from an owner seen in a path; the first one wins. */
  learnViewer(owner: string): void {
    if (this.viewerLogin === null && owner !== '') this.viewerLogin = owner;
  }

  /** Whether `owner` is the token owner (learning it first when unknown). */
  isViewer(owner: string): boolean {
    if (this.viewerLogin === null) {
      this.learnViewer(owner);
      return true;
    }
    return owner === this.viewerLogin;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  /** A repo under `owner`, or undefined when the owner is foreign or the repo is missing. */
  getRepoFor(owner: string, name: string): Repo | undefined {
    if (!this.isViewer(owner)) return undefined;
    return this.repos.get(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  createRepo(name: string, opts: { description?: string; private?: boolean }): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextItemId: 1,
      seq: this.nextRepoSeq++,
    };
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** The tip of a branch (short name), or null when it does not exist. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The tip of the default branch, or null on an unborn repo. */
  defaultTip(repo: Repo): string | null {
    return this.branchTip(repo, repo.defaultBranch);
  }

  /** Every branch, sorted by name. */
  branches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Peel an annotated tag to its commit, following tag chains. */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    const seen = new Set<string>();
    for (let i = 0; i < 16; i += 1) {
      if (seen.has(current)) return null;
      seen.add(current);
      const object = repo.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        try {
          current = parseTag(object.data).object;
        } catch {
          return null;
        }
      } else {
        return null;
      }
    }
    return null;
  }

  /**
   * Build a tree with `segments` set to `blobOid` (or removed when null),
   * reusing the parent tree's other entries. Returns the new root tree oid.
   * Empty directories left behind are pruned.
   */
  treeWithPath(repo: Repo, baseTreeOid: string | null, segments: readonly string[], blobOid: string | null): string {
    const build = (treeOid: string | null, depth: number): string | null => {
      const head = segments[depth]!;
      const last = depth === segments.length - 1;
      const entries: TreeEntry[] = [];
      if (treeOid !== null) {
        const object = repo.objects.get(treeOid);
        if (object && object.type === 'tree') {
          for (const entry of parseTree(object.data)) {
            if (entry.name !== head) entries.push(entry);
          }
        }
      }
      if (last) {
        if (blobOid !== null) entries.push({ mode: '100644', name: head, oid: blobOid });
      } else {
        const existing = treeOid !== null ? this.childTree(repo, treeOid, head) : null;
        const child = build(existing, depth + 1);
        if (child !== null) entries.push({ mode: '40000', name: head, oid: child });
      }
      if (entries.length === 0) return null;
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    const result = build(baseTreeOid, 0);
    // An empty tree is a real object git can hold; a repo whose last file was
    // deleted still needs a root tree.
    return result ?? this.putObject(repo, 'tree', buildTree([]));
  }

  private childTree(repo: Repo, treeOid: string, name: string): string | null {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === name && candidate.mode === '40000');
    return entry?.oid ?? null;
  }

  /** Create a commit on top of `parent` (null for a root commit) and return its oid. */
  createCommit(
    repo: Repo,
    opts: { tree: string; parents: readonly string[]; message: string; author?: string; committer?: string },
  ): string {
    const data = buildCommit({
      tree: opts.tree,
      parents: opts.parents,
      message: opts.message,
      author: opts.author ?? FORGE_IDENTITY,
      committer: opts.committer ?? FORGE_IDENTITY,
      timestamp: nowEpochSec(),
    });
    return this.putObject(repo, 'commit', data);
  }

  /**
   * Write (or delete, when `content` is null) a file on `branch`, creating the
   * branch from the default tip when it does not exist yet. Returns the new
   * commit oid and the blob oid (null for a delete).
   */
  commitFile(
    repo: Repo,
    opts: { branch: string; path: string; content: Buffer | null; message: string },
  ): { commitSha: string; blobSha: string | null; created: boolean } {
    const ref = `refs/heads/${opts.branch}`;
    let tip = repo.refs.get(ref) ?? null;
    let baseTree: string | null = null;
    let created = false;
    if (tip === null) {
      // A new branch starts from the default branch's tip (or nothing).
      const defaultTip = this.defaultTip(repo);
      if (defaultTip !== null && opts.branch !== repo.defaultBranch) {
        tip = defaultTip;
        created = true;
      }
    }
    if (tip !== null) {
      const commit = repo.objects.get(tip);
      if (commit && commit.type === 'commit') baseTree = parseCommit(commit.data).tree;
    }
    const segments = opts.path.split('/').filter((segment) => segment !== '');
    let blobSha: string | null = null;
    if (opts.content !== null) blobSha = this.putObject(repo, 'blob', opts.content);
    const tree = this.treeWithPath(repo, baseTree, segments, blobSha);
    const commitSha = this.createCommit(repo, {
      tree,
      parents: tip === null ? [] : [tip],
      message: opts.message,
    });
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha, created };
  }

  /** The blob at `path` on the tip of `branch`, or null when absent. */
  fileAt(repo: Repo, branch: string, path: string): { oid: string; data: Buffer; mode: string } | null {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return null;
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return null;
    const tree = parseCommit(commit.data).tree;
    const segments = path.split('/').filter((segment) => segment !== '');
    const found = lookupPath(this.lookup(repo), tree, segments);
    if (!found || found.isTree) return null;
    const blob = repo.objects.get(found.oid);
    if (!blob || blob.type !== 'blob') return null;
    return { oid: found.oid, data: blob.data, mode: found.mode };
  }

  /** The entries of the directory at `path` ('' for the root) on `branch`'s tip. */
  dirAt(
    repo: Repo,
    branch: string,
    path: string,
  ): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number | null }> | null {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return null;
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    const segments = path.split('/').filter((segment) => segment !== '');
    for (const segment of segments) {
      const object = repo.objects.get(treeOid);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    const out: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number | null }> = [];
    for (const entry of parseTree(object.data)) {
      const isDir = entry.mode === '40000';
      const blob = isDir ? undefined : repo.objects.get(entry.oid);
      out.push({
        name: entry.name,
        path: segments.length === 0 ? entry.name : `${segments.join('/')}/${entry.name}`,
        sha: entry.oid,
        type: isDir ? 'dir' : 'file',
        size: isDir ? null : (blob?.data.length ?? 0),
      });
    }
    return out;
  }

  /** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') return this.defaultTip(repo);
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return this.peelToCommit(repo, direct) ?? direct;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return this.peelToCommit(repo, tag) ?? tag;
    if (isOid(ref) && repo.objects.has(ref)) {
      const object = repo.objects.get(ref)!;
      if (object.type === 'commit') return ref;
      if (object.type === 'tag') return this.peelToCommit(repo, ref);
    }
    return null;
  }

  /** Commits reachable from `tip`, newest first (depth-first, parents after children). */
  listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string; author: string; committer: string; parents: string[] }> {
    const out: Array<{ sha: string; message: string; author: string; committer: string; parents: string[] }> = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      let parsed;
      try {
        parsed = parseCommit(object.data);
      } catch {
        continue;
      }
      // GitHub's API strips the trailing newline git appends to messages.
      out.push({ sha: oid, message: parsed.message.replace(/\n+$/, ''), author: parsed.author, committer: parsed.committer, parents: parsed.parents });
      for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i]!);
    }
    return out;
  }

  // ------------------------------------------------------------ diff + merge

  /** The file-level diff between two trees (base -> head). */
  diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): DiffFile[] {
    const lookup = this.lookup(repo);
    const base = baseTree === null ? new Map() : flattenTree(lookup, baseTree);
    const head = headTree === null ? new Map() : flattenTree(lookup, headTree);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: DiffFile[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      if (b === undefined && h !== undefined) {
        const data = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const additions = countLines(data);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h === undefined) {
        const data = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const deletions = countLines(data);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b !== undefined && h !== undefined) {
        const oldData = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const newData = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const additions = countLines(newData);
        const deletions = countLines(oldData);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** The tree oid of a commit, or null. */
  treeOf(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    try {
      return parseCommit(object.data).tree;
    } catch {
      return null;
    }
  }

  /** The files a pull request changes (merge-base of head/base -> head). */
  pullRequestFiles(repo: Repo, pull: PullRequest): DiffFile[] {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(this.lookup(repo), headTip, baseTip);
    const baseTree = base === null ? null : this.treeOf(repo, base);
    const headTree = this.treeOf(repo, headTip);
    return this.diffTrees(repo, baseTree, headTree);
  }

  /**
   * Whether a pull request would merge cleanly: every file the head changed
   * since the merge-base must be untouched on the base since the merge-base,
   * or changed to the same content.
   */
  pullRequestMergeable(repo: Repo, pull: PullRequest): boolean {
    return this.mergePlan(repo, pull).conflict === null;
  }

  /** The three-way merge plan for a pull request (or its conflict). */
  mergePlan(repo: Repo, pull: PullRequest): { conflict: string | null; tree: string | null } {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(this.lookup(repo), headTip, baseTip);
    const lookup = this.lookup(repo);
    const ancestorTree = base === null ? null : this.treeOf(repo, base);
    const ancestor = ancestorTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(lookup, ancestorTree);
    const headTree = this.treeOf(repo, headTip);
    const baseTree = this.treeOf(repo, baseTip);
    const head = headTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(lookup, headTree);
    const current = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(lookup, baseTree);
    // The merged tree starts as the base's, then takes the head's changes.
    const merged = new Map(current);
    const paths = new Set([...ancestor.keys(), ...head.keys(), ...current.keys()]);
    for (const path of paths) {
      const a = ancestor.get(path)?.oid ?? null;
      const h = head.get(path)?.oid ?? null;
      const c = current.get(path)?.oid ?? null;
      const headChanged = h !== a;
      if (!headChanged) continue;
      const baseChanged = c !== a;
      if (baseChanged && h !== c) return { conflict: path, tree: null };
      if (h === null) merged.delete(path);
      else merged.set(path, head.get(path)!);
    }
    // Rebuild the tree from the merged flat map.
    let tree: string | null = null;
    const sorted = [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [path, entry] of sorted) {
      const segments = path.split('/');
      tree = this.treeWithPath(repo, tree, segments, entry.oid);
    }
    if (tree === null) tree = this.putObject(repo, 'tree', buildTree([]));
    return { conflict: null, tree };
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit
   * sha, or null when the pull request conflicts (or is already closed).
   */
  mergePullRequest(repo: Repo, pull: PullRequest): string | null {
    if (pull.state !== 'open') return null;
    const plan = this.mergePlan(repo, pull);
    if (plan.conflict !== null || plan.tree === null) return null;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const commitSha = this.createCommit(repo, {
      tree: plan.tree,
      parents: baseTip === '' ? [] : [baseTip],
      message,
    });
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowISO();
    pull.mergeCommitSha = commitSha;
    pull.updatedAt = nowISO();
    repo.updatedAt = nowISO();
    return commitSha;
  }

  // ------------------------------------------------------------ issues + pulls

  createIssue(repo: Repo, opts: { title: string; body?: string; labels?: string[] }): Issue {
    const issue: Issue = {
      id: repo.nextItemId++,
      number: repo.nextNumber++,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      labels: [...(opts.labels ?? [])],
      comments: [],
      createdAt: nowISO(),
      updatedAt: nowISO(),
      seq: repo.nextNumber,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(
    repo: Repo,
    opts: { title: string; body?: string; head: string; base: string },
  ): PullRequest {
    const headSha = this.branchTip(repo, opts.head) ?? '';
    const baseSha = this.branchTip(repo, opts.base) ?? '';
    const pull: PullRequest = {
      id: repo.nextItemId++,
      number: repo.nextNumber++,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: opts.head,
      baseRef: opts.base,
      headSha,
      baseSha,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      seq: repo.nextNumber,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** An open pull request with the same head and base, if one exists. */
  findOpenPull(repo: Repo, head: string, base: string): PullRequest | undefined {
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) return pull;
    }
    return undefined;
  }

  /** Add a comment to an issue (null when the issue does not exist). */
  addComment(repo: Repo, number: number, body: string): IssueComment | null {
    const issue = repo.issues.get(number);
    if (issue === undefined) return null;
    const comment: IssueComment = {
      id: repo.nextItemId++,
      body,
      createdAt: issue.createdAt,
      updatedAt: issue.createdAt,
    };
    issue.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------ push validation

  /**
   * Validate one receive-pack command against the current refs. Returns null
   * when the update may apply, else the `ng` reason.
   */
  validatePushCommand(repo: Repo, command: { oldOid: string; newOid: string; ref: string }): string | null {
    const current = repo.refs.get(command.ref);
    const isDelete = command.newOid === ZERO_OID;
    const isCreate = command.oldOid === ZERO_OID;
    if (isDelete) {
      if (current === undefined) return 'no such ref';
      if (current !== command.oldOid) return 'old value does not match';
      return null;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) return 'unable to resolve the new object';
    if (current === undefined) {
      if (!isCreate) return 'old value does not match';
      return null;
    }
    if (current !== command.oldOid) return 'old value does not match';
    if (command.ref.startsWith('refs/heads/')) {
      // A branch update must fast-forward: the new tip must descend from the old.
      const newCommit = target.type === 'commit' ? command.newOid : this.peelToCommit(repo, command.newOid);
      if (newCommit === null) return 'unable to resolve the new commit';
      if (!isAncestor(this.lookup(repo), newCommit, current)) return 'non-fast-forward';
    }
    return null;
  }

  /** Apply a validated push command. */
  applyPushCommand(repo: Repo, command: { oldOid: string; newOid: string; ref: string }): void {
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
    repo.updatedAt = nowISO();
  }

  /**
   * The objects a fetch must send: everything reachable from `wants` within
   * `depth` generations (all of it when depth is null), minus everything
   * reachable from `haves`. Also reports the new shallow boundary and the
   * previously-shallow commits that are no longer shallow.
   */
  computeFetch(
    repo: Repo,
    opts: { wants: readonly string[]; haves?: readonly string[]; depth?: number | null; shallow?: readonly string[] },
  ): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
    const lookup = this.lookup(repo);
    const depth = opts.depth ?? null;
    // Included commits, by distance from the wants (0 = the wants themselves).
    const included = new Map<string, number>();
    const queue: Array<{ oid: string; distance: number }> = [];
    const extraObjects = new Set<string>();
    for (const want of opts.wants) {
      const object = lookup(want);
      if (!object) continue;
      if (object.type === 'tag') {
        extraObjects.add(want);
        const peeled = this.peelToCommit(repo, want);
        if (peeled !== null) queue.push({ oid: peeled, distance: 0 });
      } else if (object.type === 'commit') {
        queue.push({ oid: want, distance: 0 });
      } else {
        extraObjects.add(want);
      }
    }
    while (queue.length) {
      const { oid, distance } = queue.shift()!;
      if (included.has(oid)) continue;
      if (depth !== null && distance >= depth) continue;
      included.set(oid, distance);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      let parents: string[];
      try {
        parents = parseCommit(object.data).parents;
      } catch {
        continue;
      }
      for (const parent of parents) {
        if (!included.has(parent)) queue.push({ oid: parent, distance: distance + 1 });
      }
    }
    // The shallow boundary: the deepest included commits that still have parents.
    const shallow: string[] = [];
    if (depth !== null) {
      for (const [oid, distance] of included) {
        if (distance !== depth - 1) continue;
        const object = lookup(oid);
        if (!object || object.type !== 'commit') continue;
        let parents: string[] = [];
        try {
          parents = parseCommit(object.data).parents;
        } catch {
          continue;
        }
        if (parents.length > 0) shallow.push(oid);
      }
      shallow.sort();
    }
    const unshallow: string[] = [];
    if (opts.shallow) {
      const shallowSet = new Set(shallow);
      for (const oid of opts.shallow) {
        if (included.has(oid) && !shallowSet.has(oid)) unshallow.push(oid);
      }
      unshallow.sort();
    }
    // The send set: included commits + their tree closures + the extra objects,
    // minus everything reachable from the haves.
    const send = new Set<string>();
    for (const oid of included.keys()) {
      const object = lookup(oid);
      if (!object) continue;
      send.add(oid);
      if (object.type === 'commit') {
        let tree: string;
        try {
          tree = parseCommit(object.data).tree;
        } catch {
          continue;
        }
        for (const reached of collectReachable([tree], lookup, { allowMissing: true })) send.add(reached);
      }
    }
    for (const oid of extraObjects) {
      for (const reached of collectReachable([oid], lookup, { allowMissing: true })) send.add(reached);
    }
    if (opts.haves && opts.haves.length > 0) {
      // A shallow client's haves stop at its shallow boundary: it holds
      // those commits but not their parents, so the held set must not
      // traverse past them (else a deepen would send nothing).
      const held = collectReachable(opts.haves, lookup, {
        allowMissing: true,
        boundary: opts.shallow ? new Set(opts.shallow) : undefined,
      });
      for (const oid of held) send.delete(oid);
    }
    const objects = new Map<string, GitObject>();
    // Deterministic order: commits first (by discovery), then tags, trees, blobs.
    const ordered = [...send].sort((a, b) => {
      const ta = lookup(a)?.type ?? '';
      const tb = lookup(b)?.type ?? '';
      const rank = (t: string): number => (t === 'commit' ? 0 : t === 'tag' ? 1 : t === 'tree' ? 2 : 3);
      const diff = rank(ta) - rank(tb);
      return diff !== 0 ? diff : a < b ? -1 : a > b ? 1 : 0;
    });
    for (const oid of ordered) {
      const object = lookup(oid);
      if (object) objects.set(oid, object);
    }
    return { objects, shallow, unshallow };
  }
}

/**
 * Git smart HTTP at /{owner}/{repo}.git: upload-pack protocol v2 (with a
 * v0 fallback) and receive-pack v0. The object model and pack codec live in
 * gitobj.ts; this module is the wire framing and the request/response shapes
 * the suite's client speaks.
 *
 * - info/refs answers the v2 capability advertisement when the request
 *   carries `Git-Protocol: version=2`, else the v0 ref advertisement.
 * - ls-refs honours peel/symrefs/unborn/ref-prefix.
 * - fetch answers the v2 sections (acknowledgments, shallow-info, packfile)
 *   with a sideband-framed, checksummed pack; a v0 request gets NAK/ACK
 *   lines and the same sideband pack.
 * - receive-pack unpacks the pack (deltas included), applies fast-forward
 *   updates per ref, and reports each ref ok/ng inside sideband band 1.
 * - A missing repository is 404 on info/refs; a malformed request is 400
 *   and the server stays up.
 */

import type { ForgeStore, Repo } from './store.ts';
import { readPack, writePack, type GitObject } from './gitobj.ts';
import {
  decodePktLines,
  decodePktLinesPrefix,
  encodePktLines,
  packetsToLines,
  pktLine,
  sidebandPackets,
  type PktLine,
} from './pktline.ts';
import { route, type RequestView, type ResponseView } from './server.ts';
import { isOid, ZERO_OID } from './util.ts';

const AGENT = 'forge/1.0';

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const V0_UPLOAD_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed filter agent=forge/1.0';
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

/** Resolve a git repo from the route params; 404 (JSON) when foreign or missing. */
function resolveGitRepo(req: RequestView, res: ResponseView): Repo | null {
  const store = req.ctx.store;
  const owner = req.params[0] ?? '';
  const repogit = req.params[1] ?? '';
  if (!repogit.endsWith('.git')) {
    res.error(404, 'Not Found');
    return null;
  }
  const name = repogit.slice(0, -'.git'.length);
  const repo = store.getRepoFor(owner, name);
  if (repo === undefined) {
    res.error(404, 'Not Found');
    return null;
  }
  return repo;
}

/** Refs sorted the way git advertises them: HEAD first, then alphabetical. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The v0 ref advertisement body (service preamble + ref lines + flush). */
function v0Advertisement(store: ForgeStore, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(encodePktLines(['flush']));
  const caps =
    service === 'git-upload-pack'
      ? `${V0_UPLOAD_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `${V0_RECEIVE_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  const defaultTip = store.branchTip(repo, repo.defaultBranch);
  if (defaultTip !== null) lines.push(`${defaultTip} HEAD`);
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}`);
    if (ref.name.startsWith('refs/tags/')) {
      const peeled = store.peelToCommit(repo, ref.oid);
      const object = store.getObject(repo, ref.oid);
      if (peeled !== null && object?.type === 'tag' && peeled !== ref.oid) {
        lines.push(`${peeled} ${ref.name}^{}`);
      }
    }
  }
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\u0000${caps}\n` : `${line}\n`));
    });
  }
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

/** The v2 capability advertisement body. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    encodePktLines(['flush']),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    encodePktLines(['flush']),
  ]);
}

/** The v2 ls-refs response for the requested arguments. */
function lsRefsResponse(
  store: ForgeStore,
  repo: Repo,
  opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] },
): Buffer {
  const lines: string[] = [];
  const matchPrefix = (name: string): boolean =>
    opts.prefixes.length === 0 || opts.prefixes.some((prefix) => name.startsWith(prefix));
  const defaultTip = store.branchTip(repo, repo.defaultBranch);
  // HEAD is a ref like any other for prefix matching: a clone asks for
  // `ref-prefix HEAD` and needs the symref line back.
  if (matchPrefix('HEAD')) {
    const symref = opts.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    if (defaultTip !== null) lines.push(`${defaultTip} HEAD${symref}\n`);
    else if (opts.unborn) lines.push(`unborn HEAD${symref}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!matchPrefix(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (opts.peel && ref.name.startsWith('refs/tags/')) {
      const object = store.getObject(repo, ref.oid);
      if (object?.type === 'tag') {
        const peeled = store.peelToCommit(repo, ref.oid);
        if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  const parts = lines.map((line) => pktLine(line));
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/** Parse a v2 fetch command's argument lines (after the delim). */
function parseV2FetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    } else if (line === 'done') {
      args.done = true;
    }
    // thin-pack, ofs-delta, no-progress, filter, wait-for-done, agent,
    // object-format, deepen-since, deepen-not: accepted, no action needed.
  }
  return args;
}

/** Parse a v0 upload-pack request body (want/have/done/deepen/shallow). */
function parseV0FetchArgs(packets: readonly PktLine[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const oid = rest.split(' ')[0] ?? '';
      if (isOid(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    } else if (line === 'done') {
      args.done = true;
    }
  }
  return args;
}

/**
 * The v2 fetch response: acknowledgments, shallow-info (when there is any),
 * and the packfile section with the sideband-framed pack.
 */
function v2FetchResponse(store: ForgeStore, repo: Repo, args: FetchArgs): Buffer {
  // A negotiation round (haves, no done): acknowledgments only, terminated
  // by a flush. Over HTTP the response-end packet is synthesized by git's
  // own transport; sending one in the body is rejected. The suite always
  // sends done, so this path serves real git clients.
  if (!args.done && args.haves.length > 0) {
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    const known = args.haves.filter((oid) => store.getObject(repo, oid) !== undefined);
    if (known.length > 0) {
      for (const oid of known) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(encodePktLines(['flush']));
    return Buffer.concat(parts);
  }
  const { objects, shallow, unshallow } = store.computeFetch(repo, {
    wants: args.wants,
    haves: args.haves,
    depth: args.depth,
    shallow: args.shallow,
  });
  const pack = writePack(objects.values());
  const parts: Buffer[] = [];
  // No acknowledgments section in the final response: real git expects the
  // packfile (or shallow-info) first once done was sent, and the suite
  // never reads acks/ready.
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(encodePktLines(['flush']));
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

/** The v0 fetch response: NAK/ACK lines, shallow lines, then the sideband pack. */
function v0FetchResponse(store: ForgeStore, repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = store.computeFetch(repo, {
    wants: args.wants,
    haves: args.haves,
    depth: args.depth,
    shallow: args.shallow,
  });
  const pack = writePack(objects.values());
  const parts: Buffer[] = [];
  const knownHaves = args.haves.filter((oid) => store.getObject(repo, oid) !== undefined);
  if (knownHaves.length > 0) {
    for (const oid of knownHaves) parts.push(pktLine(`ACK ${oid}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function registerGitRoutes(): void {
  route('GET', '/:owner/:repogit/info/refs', (req, res) => {
    const repo = resolveGitRepo(req, res);
    if (repo === null) return;
    const service = req.query.get('service') ?? '';
    const store = req.ctx.store;
    if (service === 'git-upload-pack') {
      const protocol = String(req.headers['git-protocol'] ?? '');
      if (protocol === 'version=2') {
        res.raw(200, UPLOAD_ADVERTISEMENT, v2Advertisement());
      } else {
        res.raw(200, UPLOAD_ADVERTISEMENT, v0Advertisement(store, repo, 'git-upload-pack'));
      }
      return;
    }
    if (service === 'git-receive-pack') {
      res.raw(200, RECEIVE_ADVERTISEMENT, v0Advertisement(store, repo, 'git-receive-pack'));
      return;
    }
    res.error(404, 'Not Found');
  });

  route('POST', '/:owner/:repogit/git-upload-pack', (req, res) => {
    const repo = resolveGitRepo(req, res);
    if (repo === null) return;
    const store = req.ctx.store;
    let packets: PktLine[];
    try {
      packets = decodePktLines(req.body);
    } catch (err) {
      res.error(400, err instanceof Error ? err.message : 'malformed pkt-line stream');
      return;
    }
    const lines = packetsToLines(packets);
    const first = (lines[0] ?? '').replace(/\n$/, '');
    if (first.startsWith('command=')) {
      const command = first.slice('command='.length).trim();
      // Arguments follow the delim packet.
      const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
      const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : packets.slice(1);
      const argLines = packetsToLines(argPackets);
      if (command === 'ls-refs') {
        const opts = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
        for (const raw of argLines) {
          const line = raw.replace(/\n$/, '');
          if (line === 'peel') opts.peel = true;
          else if (line === 'symrefs') opts.symrefs = true;
          else if (line === 'unborn') opts.unborn = true;
          else if (line.startsWith('ref-prefix ')) opts.prefixes.push(line.slice('ref-prefix '.length));
        }
        res.raw(200, UPLOAD_RESULT, lsRefsResponse(store, repo, opts));
        return;
      }
      if (command === 'fetch') {
        const args = parseV2FetchArgs(argLines);
        res.raw(200, UPLOAD_RESULT, v2FetchResponse(store, repo, args));
        return;
      }
      res.error(400, `unknown upload-pack command ${JSON.stringify(command)}`);
      return;
    }
    // v0: want/have/done/deepen/shallow lines.
    const args = parseV0FetchArgs(packets);
    if (args.wants.length === 0) {
      res.error(400, 'no want lines in upload-pack request');
      return;
    }
    res.raw(200, UPLOAD_RESULT, v0FetchResponse(store, repo, args));
  });

  route('POST', '/:owner/:repogit/git-receive-pack', (req, res) => {
    const repo = resolveGitRepo(req, res);
    if (repo === null) return;
    const store = req.ctx.store;
    let prefix: { packets: PktLine[]; consumed: number; sawFlush: boolean };
    try {
      prefix = decodePktLinesPrefix(req.body);
    } catch (err) {
      res.error(400, err instanceof Error ? err.message : 'malformed pkt-line stream');
      return;
    }
    if (!prefix.sawFlush) {
      res.error(400, 'receive-pack request has no command flush');
      return;
    }
    const commands: PushCommand[] = [];
    let capabilities = new Set<string>();
    let firstLine = true;
    for (const packet of prefix.packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\u0000');
      let line = text;
      if (nul >= 0) {
        line = text.slice(0, nul);
        if (firstLine) {
          for (const token of text.slice(nul + 1).split(' ')) {
            if (token !== '') capabilities.add(token);
          }
        }
      }
      firstLine = false;
      const parts = line.split(' ');
      if (parts.length !== 3 || !isOid(parts[0]!) || !isOid(parts[1]!) || !parts[2]!.startsWith('refs/')) {
        res.error(400, `malformed push command ${JSON.stringify(line.slice(0, 80))}`);
        return;
      }
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    if (commands.length === 0) {
      res.error(400, 'receive-pack request has no commands');
      return;
    }
    const packBytes = req.body.subarray(prefix.consumed);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const read = readPack(packBytes, { resolveBase: (oid) => store.getObject(repo, oid) });
        for (const [oid, object] of read.objects) {
          if (!store.getObject(repo, oid)) {
            repo.objects.set(oid, object as GitObject);
          }
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
    // Validate and apply each command, reporting per ref.
    const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
    for (const command of commands) {
      if (!unpackOk) {
        reportLines.push(`ng ${command.ref} unpack error\n`);
        continue;
      }
      const problem = store.validatePushCommand(repo, command);
      if (problem !== null) {
        reportLines.push(`ng ${command.ref} ${problem}\n`);
        continue;
      }
      store.applyPushCommand(repo, command);
      reportLines.push(`ok ${command.ref}\n`);
    }
    const reportStream = encodePktLines([...reportLines, 'flush']);
    const sideband = capabilities.has('side-band-64k');
    if (sideband) {
      const parts: Buffer[] = [];
      for (const packet of sidebandPackets(1, reportStream)) parts.push(packet);
      parts.push(encodePktLines(['flush']));
      res.raw(200, RECEIVE_RESULT, Buffer.concat(parts));
    } else {
      res.raw(200, RECEIVE_RESULT, reportStream);
    }
  });
}

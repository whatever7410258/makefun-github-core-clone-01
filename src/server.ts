/**
 * The HTTP server: one Node http server, a tiny router, and the shared
 * response helpers. Every JSON reply carries application/json and a
 * non-empty X-GitHub-Request-Id; every error is a JSON {message} body.
 * No request can crash the server: each handler is wrapped, and a handler
 * that throws answers 500 JSON.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ForgeStore } from './store.ts';
import { nextRequestId } from './util.ts';

/** Largest request body accepted (push packs stay far below this). */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface ForgeContext {
  store: ForgeStore;
  /** The bearer token the suite presents ('' when unset: dev mode, accept any). */
  token: string;
  /** The port this server listens on (for absolute Link URLs). */
  port: number;
}

export interface RouteMatch {
  handler: (req: RequestView, res: ResponseView) => Promise<void> | void;
  params: string[];
}

export interface RequestView {
  method: string;
  /** The decoded path (no query string). */
  path: string;
  /** Raw query string (without '?'). */
  queryString: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  /** The raw request body (read fully before the handler runs). */
  body: Buffer;
  /** The Host header's value, for absolute URLs. */
  host: string;
  /** The request's route parameters (decoded path segments). */
  params: string[];
  /** The parsed JSON body, when the content type is JSON and it parsed. */
  json: unknown;
  /** True when a JSON body was present but did not parse. */
  jsonParseError: boolean;
  ctx: ForgeContext;
}

export class ResponseView {
  private res: ServerResponse;
  private sent = false;

  constructor(res: ServerResponse) {
    this.res = res;
  }

  get headersSent(): boolean {
    return this.sent;
  }

  /** Send a JSON body with the given status. */
  json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    if (this.sent) return;
    this.sent = true;
    const text = JSON.stringify(body);
    this.res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': nextRequestId(),
      'content-length': Buffer.byteLength(text),
      ...extraHeaders,
    });
    this.res.end(text);
  }

  /** Send a JSON error body: {message}. */
  error(status: number, message: string, extraHeaders: Record<string, string> = {}): void {
    this.json(status, { message }, extraHeaders);
  }

  /** Send raw bytes with an explicit content type. */
  raw(status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
    if (this.sent) return;
    this.sent = true;
    this.res.writeHead(status, {
      'content-type': contentType,
      'x-github-request-id': nextRequestId(),
      'content-length': body.length,
      ...extraHeaders,
    });
    this.res.end(body);
  }

  /** Send an empty body with the given status (204 included). */
  empty(status: number, extraHeaders: Record<string, string> = {}): void {
    if (this.sent) return;
    this.sent = true;
    this.res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': nextRequestId(),
      ...extraHeaders,
    });
    this.res.end();
  }
}

type RouteHandler = (req: RequestView, res: ResponseView) => Promise<void> | void;

interface Route {
  method: string;
  /** Segments; a segment starting with ':' captures one path segment, '*' captures the rest. */
  pattern: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

export function route(method: string, path: string, handler: RouteHandler): void {
  const pattern = path.split('/').filter((segment) => segment !== '');
  routes.push({ method, pattern, handler });
}

/** Match a method+path against the table; returns the handler and captures. */
function match(method: string, path: string): RouteMatch | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  for (const entry of routes) {
    if (entry.method !== method && entry.method !== '*') continue;
    const params: string[] = [];
    let ok = entry.pattern.length <= segments.length;
    if (entry.pattern.length !== segments.length && !entry.pattern.includes('*')) ok = false;
    if (!ok) continue;
    let matched = true;
    for (let i = 0; i < entry.pattern.length; i += 1) {
      const want = entry.pattern[i]!;
      if (want === '*') {
        params.push(segments.slice(i).map(decodeSegment).join('/'));
        break;
      }
      const got = segments[i];
      if (got === undefined) {
        matched = false;
        break;
      }
      if (want.startsWith(':')) params.push(decodeSegment(got));
      else if (want !== got) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: entry.handler, params };
  }
  return null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Read the request body fully (up to MAX_BODY_BYTES). */
function readBody(req: IncomingMessage): Promise<{ body: Buffer; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ body: Buffer.concat(chunks), tooLarge }));
    req.on('error', reject);
  });
}

/** Whether the request carries the suite's bearer token. */
export function isAuthorized(req: RequestView): boolean {
  const expected = req.ctx.token;
  if (expected === '') return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  return header === `Bearer ${expected}`;
}

/** The origin of this request (from its Host header), for absolute Link URLs. */
export function requestOrigin(req: RequestView): string {
  const host = req.host !== '' ? req.host : `127.0.0.1:${req.ctx.port}`;
  return `http://${host}`;
}

/** Create the HTTP server. Routes are registered by the surface modules. */
export function createForgeServer(ctx: ForgeContext) {
  const server = createServer(async (incoming, outgoing) => {
    const res = new ResponseView(outgoing);
    try {
      const rawUrl = incoming.url ?? '/';
      const question = rawUrl.indexOf('?');
      const rawPath = question >= 0 ? rawUrl.slice(0, question) : rawUrl;
      const queryString = question >= 0 ? rawUrl.slice(question + 1) : '';
      let path: string;
      try {
        path = decodeURIComponent(rawPath);
      } catch {
        path = rawPath;
      }
      // A request with neither content-length nor transfer-encoding has no
      // body: skip the stream read (the read workload is 2,000 such GETs).
      const hasBody =
        incoming.headers['content-length'] !== undefined || incoming.headers['transfer-encoding'] !== undefined;
      let body: Buffer;
      if (!hasBody) {
        body = Buffer.alloc(0);
      } else {
        const read = await readBody(incoming);
        if (read.tooLarge) {
          res.error(413, 'request body too large');
          return;
        }
        body = read.body;
      }
      const contentType = String(incoming.headers['content-type'] ?? '');
      let json: unknown = undefined;
      let jsonParseError = false;
      if (body.length > 0 && contentType.includes('application/json')) {
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          jsonParseError = true;
        }
      }
      const matched = match(incoming.method ?? 'GET', path);
      if (matched === null) {
        res.error(404, 'Not Found');
        return;
      }
      const req: RequestView = {
        method: incoming.method ?? 'GET',
        path,
        queryString,
        query: new URLSearchParams(queryString),
        headers: incoming.headers,
        body,
        host: String(incoming.headers.host ?? ''),
        params: matched.params,
        json,
        jsonParseError,
        ctx,
      };
      await matched.handler(req, res);
    } catch (err) {
      // A handler must never take the server down with it.
      try {
        if (!res.headersSent) res.error(500, err instanceof Error ? err.message : 'internal error');
      } catch {
        // The socket is already gone; nothing left to do.
      }
    }
  });
  // Keep-alive matters for the read workload (2,000 GETs on one connection).
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 0;
  return server;
}

/**
 * Small shared helpers: hashing, base64, deterministic timestamps, ids.
 *
 * Determinism rule: nothing in a response may come from the wall clock or an
 * unseeded random source. All timestamps derive from MAKEFUN_TRIAL_NOW
 * (parsed once at startup); when it is absent a fixed epoch is used so a
 * local run is reproducible too.
 */

import { createHash } from 'node:crypto';

/** Fixed fallback "now" (2025-01-01T00:00:00Z) when MAKEFUN_TRIAL_NOW is unset. */
export const FALLBACK_NOW_ISO = '2025-01-01T00:00:00.000Z';
export const FALLBACK_NOW_EPOCH = 1735689600;

let nowIso = FALLBACK_NOW_ISO;
let nowEpoch = FALLBACK_NOW_EPOCH;

/** Set the trial's "now" from MAKEFUN_TRIAL_NOW (an ISO string). */
export function initNow(value: string | undefined): void {
  if (value === undefined || value === '') return;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return;
  nowIso = new Date(ms).toISOString();
  nowEpoch = Math.floor(ms / 1000);
}

/** The trial's "now" as an ISO-8601 string (used for every created_at/updated_at). */
export function nowISO(): string {
  return nowIso;
}

/** The trial's "now" as Unix seconds (used for git commit timestamps). */
export function nowEpochSec(): number {
  return nowEpoch;
}

/** SHA-1 hex of the given bytes. */
export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** SHA-1 digest (raw 20 bytes) of the given bytes. */
export function sha1Bytes(data: Uint8Array): Buffer {
  return createHash('sha1').update(data).digest();
}

/** Strict base64 decode: returns null when the text is not valid base64. */
export function b64decode(text: string): Buffer | null {
  const cleaned = text.replace(/\s+/g, '');
  if (cleaned === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) return null;
  try {
    return Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
}

/** Base64 encode (no line wrapping). */
export function b64encode(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

/** Standard base64 (with padding) of UTF-8 text — the shape GitHub uses for global ids. */
export function b64encodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Decode standard base64 text, or null on failure. */
export function b64decodeText(text: string): string | null {
  const buf = b64decode(text);
  if (buf === null) return null;
  return buf.toString('utf8');
}

/** A monotonic request counter for X-GitHub-Request-Id values. */
let requestCounter = 0;

/** The next request id: deterministic within a run (the suite never compares them). */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${String(requestCounter).padStart(8, '0')}`;
}

/** True for a lowercase 40-hex object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export const ZERO_OID = '0'.repeat(40);

/** Lowercase a string, safely. */
export function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/** Count the lines in a text blob (a trailing newline does not add a line). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

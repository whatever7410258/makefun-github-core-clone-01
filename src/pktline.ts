/**
 * The pkt-line codec git's smart HTTP speaks: 0000 flush, 0001 delim, 0002
 * response-end, 4-hex-length framing, max 65520 bytes a packet (git's
 * LARGE_PACKET_MAX). Sideband framing (band 1 = data, 2 = progress,
 * 3 = error) rides inside pkt-lines for fetch packs and push reports.
 */

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** Largest band-1 data chunk: the pkt-line header (4) + the band byte (1). */
export const SIDEBAND_MAX_DATA = PKT_LINE_MAX - 5;

export type PktLine =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a mixed sequence; 'flush'/'delim'/'response-end' are the control packets. */
export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else if (item === 'response-end') parts.push(pktResponseEnd());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode pkt-lines from the start of a buffer until the first flush (or the
 * end of the buffer). Returns the packets and how many bytes were consumed,
 * so a caller can read the raw bytes that follow (a receive-pack's pack).
 * Throws on a malformed header.
 */
export function decodePktLinesPrefix(
  bytes: Uint8Array,
): { packets: PktLine[]; consumed: number; sawFlush: boolean } {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const packets: PktLine[] = [];
  let offset = 0;
  let sawFlush = false;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      sawFlush = true;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset, sawFlush };
}

/** Decode a whole buffer into packets (no trailing bytes allowed). */
export function decodePktLines(bytes: Uint8Array): PktLine[] {
  const { packets, consumed } = decodePktLinesPrefixAll(bytes);
  void consumed;
  return packets;
}

function decodePktLinesPrefixAll(bytes: Uint8Array): { packets: PktLine[]; consumed: number } {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const packets: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3) throw new Error('invalid pkt-line length 0003');
    if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The decoded text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly PktLine[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

/**
 * Wrap bytes into sideband pkt-lines on `band`, chunked so no pkt-line
 * exceeds the maximum. Band 1 is data, 2 progress, 3 error.
 */
export function sidebandPackets(band: 1 | 2 | 3, data: Uint8Array): Buffer[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const out: Buffer[] = [];
  let offset = 0;
  if (buffer.length === 0) {
    out.push(pktLine(Buffer.from([band])));
    return out;
  }
  while (offset < buffer.length) {
    const chunk = buffer.subarray(offset, offset + SIDEBAND_MAX_DATA);
    const framed = Buffer.concat([Buffer.from([band]), chunk]);
    out.push(pktLine(framed));
    offset += chunk.length;
  }
  return out;
}

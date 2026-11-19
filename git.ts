// Git smart HTTP: pkt-line framing, packfiles (read with delta resolution, write
// as full objects with a per-object deflate cache), protocol v2 upload-pack
// (ls-refs, fetch with shallow/deepen) and v0 receive-pack (push with report-status).
// No git binary anywhere: everything is node:zlib and node:crypto, on the store.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type ObjType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function decodePktLines(buf: Buffer): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
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
    if (length < 4 || offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

export function pktLinesText(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------- pack reading

const TYPE_NAMES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
}

function readSizeEncoding(buf: Buffer, offset: number): { size: number; type: number; next: number } {
  let byte = buf[offset];
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let next = offset + 1;
  while (byte & 0x80) {
    byte = buf[next];
    next += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, type, next };
}

function readOffsetEncoding(buf: Buffer, offset: number): { baseOffset: number; next: number } {
  let byte = buf[offset];
  let baseOffset = byte & 0x7f;
  let next = offset + 1;
  while (byte & 0x80) {
    byte = buf[next];
    next += 1;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset, next };
}

/** Inflate the zlib stream at `offset`, knowing its expected output size. */
export function inflateAt(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  const slice = buf.subarray(offset);
  try {
    const result = inflateSync(slice, { info: true }) as unknown as { buffer: Buffer; engine?: { bytesWritten?: number } };
    const consumed = result.engine?.bytesWritten;
    if (typeof consumed === 'number' && consumed > 0 && result.buffer.length === expectedSize) {
      return { data: result.buffer, next: offset + consumed };
    }
  } catch {
    // fall through to the binary search
  }
  // Binary search the smallest prefix that inflates to exactly the expected size.
  let lo = offset;
  let hi = buf.length;
  const ok = (end: number): boolean => {
    try {
      return inflateSync(buf.subarray(offset, end)).length === expectedSize;
    } catch {
      return false;
    }
  };
  if (!ok(hi)) throw new Error('corrupt zlib stream in packfile');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return { data: inflateSync(buf.subarray(offset, lo)), next: lo };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset] << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset] << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      total += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(parts);
}

export interface PackRead {
  entries: PackEntry[];
  objects: Map<string, GitObject>;
}

/** Read a packfile, resolving deltas against the pack itself and `resolveBase`. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const { size, type, next } = readSizeEncoding(pack, offset);
    offset = next;
    let objectType: ObjType;
    let data: Buffer;
    if (type === 6) {
      const { baseOffset, next: after } = readOffsetEncoding(pack, offset);
      offset = after;
      const inflated = inflateAt(pack, offset, size);
      offset = inflated.next;
      const baseEntry = byOffset.get(entryOffset - baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
      data = applyDelta(baseEntry.data, inflated.data);
      objectType = baseEntry.type;
    } else if (type === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset, size);
      offset = inflated.next;
      const base = byOffset.get(entryOffset) ?? undefined;
      const baseObject = base !== undefined ? { type: base.type, data: base.data } : resolveBase?.(baseOid);
      if (baseObject === undefined) throw new Error(`ref-delta base ${baseOid} not found`);
      data = applyDelta(baseObject.data, inflated.data);
      objectType = baseObject.type;
    } else {
      objectType = TYPE_NAMES[type] as ObjType;
      if (objectType === undefined) throw new Error(`unknown pack object type ${type}`);
      const inflated = inflateAt(pack, offset, size);
      offset = inflated.next;
      data = inflated.data;
    }
    const oid = hashObject(objectType, data);
    const entry: PackEntry = { type: objectType, data, oid };
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== actual) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  for (const entry of entries) objects.set(entry.oid, { type: entry.type, data: entry.data });
  return { entries, objects };
}

// ---------------------------------------------------------------- pack writing

/** Cache of the compressed (header + deflate) form of each object, keyed by oid. */
const deflateCache = new Map<string, Buffer>();

function compressedObject(object: GitObject): Buffer {
  const oid = hashObject(object.type, object.data);
  const cached = deflateCache.get(oid);
  if (cached !== undefined) return cached;
  const header = writePackObjectHeader(object.type, object.data.length);
  const body = deflateSync(object.data, { level: 1 });
  const out = Buffer.concat([header, body]);
  deflateCache.set(oid, out);
  return out;
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A packfile of full (non-delta) objects, version 2, with a SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.alloc(12)];
  parts[0].write('PACK', 0, 'ascii');
  parts[0].writeUInt32BE(2, 4);
  parts[0].writeUInt32BE(list.length, 8);
  for (const object of list) parts.push(compressedObject(object));
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- ref helpers

export function peeledOid(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const target = parseTag(object.data).object;
  const targetObject = repo.objects.get(target);
  if (targetObject === undefined) return null;
  if (targetObject.type === 'tag') return peeledOid(repo, target);
  return target;
}

export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------- v2 advertisement

export function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow ofs-delta\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

export function v0ReceiveAdvertisement(repo: Repo): Buffer {
  const caps = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';
  const refs = sortedRefs(repo);
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n')];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const first = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(first));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    });
    const head = refs.find((ref) => ref.name === 'refs/heads/main');
    if (head !== undefined) parts.push(pktLine(`${head.oid} HEAD\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v2 ls-refs

export interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function parseLsRefs(packets: readonly Packet[]): LsRefsRequest {
  const request: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line === 'peel') request.peel = true;
    else if (line === 'symrefs') request.symrefs = true;
    else if (line === 'unborn') request.unborn = true;
    else if (line.startsWith('ref-prefix ')) request.prefixes.push(line.slice('ref-prefix '.length));
  }
  return request;
}

export function lsRefsResponse(repo: Repo, request: LsRefsRequest): Buffer {
  const parts: Buffer[] = [];
  const hasRefs = repo.refs.size > 0;
  const mainTip = repo.refs.get('refs/heads/main');
  const include = (name: string): boolean =>
    request.prefixes.length === 0 || request.prefixes.some((prefix) => name.startsWith(prefix));
  if (request.prefixes.length === 0) {
    if (hasRefs && mainTip !== undefined) {
      parts.push(pktLine(`${mainTip} HEAD symref-target:refs/heads/main\n`));
    } else if (request.unborn) {
      parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!include(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (request.peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v2 fetch

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

export function parseFetch(packets: readonly Packet[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isFinite(depth)) request.depth = depth;
    } else if (line === 'done') request.done = true;
  }
  return request;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const data = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), data])));
  }
  return out;
}

/**
 * The objects a fetch must send: reachable from the wants, minus what the haves
 * already reach, honouring depth. Returns the objects and the shallow boundary.
 */
export function fetchObjects(
  repo: Repo,
  request: FetchRequest,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  // What the client already holds: reachable from its haves, but never past a
  // shallow boundary it named — a shallow clone holds its boundary commit and
  // its tree, not the history below it. (A deepen fetch sends haves=[tip] with
  // shallow=[tip]; subtracting the tip's whole history would swallow the
  // parent the deepen is meant to deliver.)
  const shallowSet = new Set(request.shallow);
  const held = new Set<string>();
  const addTreeTo = (target: Set<string>, treeOid: string): void => {
    const queue: string[] = [treeOid];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (target.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      target.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) queue.push(entry.oid);
      }
    }
  };
  {
    const queue: string[] = [...request.haves];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      if (object.type === 'commit') {
        held.add(oid);
        addTreeTo(held, parseCommit(object.data).tree);
        if (!shallowSet.has(oid)) {
          for (const parent of parseCommit(object.data).parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        held.add(oid);
        queue.push(parseTag(object.data).object);
      } else {
        held.add(oid);
      }
    }
  }
  const depth = request.depth;
  const included = new Set<string>();
  const shallow: string[] = [];
  const visited = new Set<string>();
  // BFS over commits from the wants, tracking generation depth (want = depth 1).
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of request.wants) {
    if (isOid(want)) queue.push({ oid: want, depth: 1 });
  }
  const includedCommits = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth: generation } = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (depth !== null && generation > depth) continue;
    includedCommits.add(oid);
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) queue.push({ oid: parent, depth: generation + 1 });
  }
  // A commit is a shallow boundary when it is included but at least one of its
  // parents is not: with deepen 1 that is the tip, with deepen 2 the parent.
  if (depth !== null) {
    for (const oid of includedCommits) {
      const commit = parseCommit(repo.objects.get(oid)!.data);
      if (commit.parents.some((parent) => !includedCommits.has(parent))) shallow.push(oid);
    }
  }
  // Send the included commits and their trees only: never descend past an
  // included commit into a parent the depth limit excluded. (A depth-1 clone
  // must carry the tip, its tree and its blobs — and no parent commit.)
  const send = new Set<string>();
  for (const oid of includedCommits) {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    send.add(oid);
    addTreeTo(send, parseCommit(object.data).tree);
  }
  // Tags wanted directly: include the tag object and its target's tree.
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag') {
      send.add(want);
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') {
        send.add(target);
        addTreeTo(send, parseCommit(targetObject.data).tree);
      }
    }
  }
  // Never re-send what the client already holds.
  for (const oid of held) send.delete(oid);
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  // Deterministic pack order: commits first (by insertion), then trees, then blobs.
  const rank = (object: GitObject): number => (object.type === 'commit' ? 0 : object.type === 'tag' ? 1 : object.type === 'tree' ? 2 : 3);
  objects.sort((a, b) => rank(a) - rank(b) || hashObject(a.type, a.data).localeCompare(hashObject(b.type, b.data)));
  const unshallow = request.shallow.filter((oid) => includedCommits.has(oid));
  return { objects, shallow: [...new Set(shallow)], unshallow };
}

export function fetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const parts: Buffer[] = [];
  // Acknowledgments.
  parts.push(pktLine('acknowledgments\n'));
  const heldHaves = request.haves.filter((have) => repo.objects.has(have));
  if (heldHaves.length > 0) {
    for (const have of heldHaves) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  const { objects, shallow, unshallow } = fetchObjects(repo, request);
  if (request.depth !== null || shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack(objects);
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v0 receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Parse a receive-pack body: command pkt-lines, a flush packet, then the raw
 * packfile. The pkt-lines are read one at a time and stop at the flush: the
 * packfile bytes that follow are not pkt-lines and must never be parsed as such.
 */
export function parsePush(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const commands: PushCommand[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const hex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line');
    let line = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match === null) throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
    offset += length;
  }
  const pack = offset < body.length ? body.subarray(offset) : null;
  return { commands, pack };
}

export function applyPush(
  repo: Repo,
  commands: readonly PushCommand[],
  packObjects: Map<string, GitObject>,
): { unpackOk: boolean; unpackDetail: string; reports: PushReportLine[] } {
  const reports: PushReportLine[] = [];
  for (const object of packObjects.values()) {
    repo.putObject(object.type, object.data);
  }
  // Re-register commit insertion order for pushed commits.
  for (const [oid, object] of packObjects) {
    if (object.type === 'commit' && !repo.commitSeq.has(oid)) {
      repo.putCommit(object.data);
    }
  }
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined || current !== command.oldOid) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.delete(command.ref);
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) {
      reports.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== command.oldOid) {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (object.type === 'commit' && !repo.isAncestor(current, command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reports.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, unpackDetail: 'ok', reports };
}

export function pushReportResponse(
  unpackOk: boolean,
  unpackDetail: string,
  reports: readonly PushReportLine[],
): Buffer {
  const lines: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const report of reports) {
    lines.push(pktLine(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`));
  }
  lines.push(pktFlush());
  const reportBody = Buffer.concat(lines);
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < reportBody.length; offset += CHUNK) {
    const data = reportBody.subarray(offset, Math.min(reportBody.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), data])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

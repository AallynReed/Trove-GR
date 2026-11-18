// Trove .tmod reader: header table, zlib or stored-block de-framing, checksum-verified.
import { inflate } from './inflate.js';

const CHUNK = 32768;
const FNV_OFFSET = 2166136261, FNV_PRIME = 16777619;

const se = (b) => (b << 24 >> 24) >>> 0;

// Trove's FNV-1a variant over little-endian words, tail bytes sign-extended.
export function calculateHash(d) {
  let h = FNV_OFFSET;
  const n = d.length - (d.length % 4);
  for (let i = 0; i < n; i += 4) {
    const w = (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;
    h = Math.imul(FNV_PRIME, (h ^ w) >>> 0) >>> 0;
  }
  const r = d.length - n;
  if (!r) return h;
  let val;
  if (r === 1) val = se(d[n]);
  else if (r === 2) val = ((se(d[n]) << 8) | se(d[n + 1])) >>> 0;
  else val = ((((se(d[n]) << 8) | se(d[n + 1])) << 8) | se(d[n + 2])) >>> 0;
  return Math.imul(FNV_PRIME, (h ^ val) >>> 0) >>> 0;
}

function leb(d, p) {
  let out = 0, shift = 0;
  for (;;) {
    if (p.pos >= d.length) return null;
    const b = d[p.pos++];
    if (shift < 32) out = (out + (b & 0x7f) * 2 ** shift) % 4294967296;
    if (!(b & 0x80)) return out;
    shift += 7;
    if (shift >= 64) return null;
  }
}

function charSpan(d, pos, chars) {
  let end = pos;
  for (let i = 0; i < chars; i++) {
    if (end >= d.length) return null;
    const b = d[end];
    end += b <= 0x7f ? 1 : (b >= 0xc2 && b <= 0xdf) ? 2 : (b >= 0xe0 && b <= 0xef) ? 3 : (b >= 0xf0 && b <= 0xf4) ? 4 : NaN;
    if (Number.isNaN(end)) return null;
  }
  return end <= d.length ? end - pos : null;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function parse(d, headerSize, propCount, chars) {
  const p = { pos: 12 };
  const string = (declared) => {
    const span = chars ? charSpan(d, p.pos, declared) : declared;
    if (span === null || p.pos + span > d.length) return null;
    let s;
    try { s = utf8.decode(d.subarray(p.pos, p.pos + span)); } catch { return null; }
    p.pos += span;
    return s;
  };
  const properties = [];
  for (let i = 0; i < propCount; i++) {
    let n = leb(d, p); if (n === null) return null;
    const name = string(n); if (name === null) return null;
    n = leb(d, p); if (n === null) return null;
    const value = string(n); if (value === null) return null;
    properties.push([name, value]);
  }
  const entries = [];
  while (p.pos < headerSize) {
    if (p.pos >= d.length) return null;
    const n = d[p.pos++];
    const path = string(n); if (path === null) return null;
    const index = leb(d, p), offset = leb(d, p), size = leb(d, p), checksum = leb(d, p);
    if (index === null || offset === null || size === null || checksum === null) return null;
    entries.push({ path, index, offset, size, checksum });
  }
  return p.pos === headerSize ? { properties, entries } : null;
}

function deframe(data) {
  const buf = data.subarray(7, Math.max(7, data.length - 5));
  const out = new Uint8Array(buf.length);
  let pos = 0, len = 0;
  const blocks = Math.floor(buf.length / (CHUNK + 5));
  for (let i = 0; i < blocks; i++) {
    out.set(buf.subarray(pos, pos + CHUNK), len); len += CHUNK; pos += CHUNK + 5;
  }
  const tail = buf.subarray(Math.min(pos, buf.length));
  out.set(tail, len); len += tail.length;
  return out.subarray(0, len);
}

function verify(stream, entries) {
  let checked = 0;
  for (const e of entries) {
    if (!e.size) continue;
    const end = e.offset + e.size;
    if (end > stream.length || calculateHash(stream.subarray(e.offset, end)) !== e.checksum) return false;
    if (++checked >= 4) return true;
  }
  return true;
}

function stream(primary, compressed, entries) {
  if (primary && verify(primary, entries)) return primary;
  const manual = deframe(compressed);
  return primary && !verify(manual, entries) ? primary : manual;
}

// -> { version, properties: [[k, v]], files: [{ path, data }] }; throws on a malformed file.
export function readTmod(input) {
  const d = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (d.length < 12) throw new Error('file too small to be a .tmod');
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const headerSize = Number(dv.getBigUint64(0, true));
  const version = dv.getUint16(8, true), propCount = dv.getUint16(10, true);
  if (headerSize < 12 || headerSize > d.length) throw new Error('declared header size is outside the file');
  const h = parse(d, headerSize, propCount, false) || parse(d, headerSize, propCount, true);
  if (!h) throw new Error('unreadable .tmod header');
  const props = [];
  for (const [k, v] of h.properties) {
    const slot = props.find((x) => x[0] === k);
    if (slot) slot[1] = v; else props.push([k, v]);
  }
  const compressed = d.subarray(headerSize);
  const z = inflate(compressed);
  const s = stream(z ? z.data : null, compressed, h.entries);
  const files = h.entries.map((e) => {
    const start = Math.min(e.offset, s.length), end = Math.max(start, Math.min(e.offset + e.size, s.length));
    return { path: e.path, data: s.slice(start, end) };
  });
  return { version, properties: props, files };
}

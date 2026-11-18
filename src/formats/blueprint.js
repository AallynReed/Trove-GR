// Trove .blueprint (kiwib v3/v4/v5) voxel tables.
import { inflate } from './inflate.js';

const AUTHORED = new Set([21, 18, 54, 55, 56, 24]);

export const fdiv = (a, b) => Math.floor(a / b);
export const fmod = (a, b) => a - b * Math.floor(a / b);

const i32 = (d, o) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24);
const u32 = (d, o) => i32(d, o) >>> 0;
const u16 = (d, o) => d[o] | (d[o + 1] << 8);

// Masked to 32 bits, at most 10 bytes; null when it runs off the end or is too long.
export function uleb(d, pos) {
  let result = 0, shift = 0;
  for (;;) {
    if (pos >= d.length) return null;
    const byte = d[pos++];
    if (shift < 32) result = (result + (byte & 0x7f) * 2 ** shift) % 4294967296;
    if (!(byte & 0x80)) return [result, pos];
    shift += 7;
    if (shift >= 64) return null;
  }
}

function svarint(d, pos) {
  const r = uleb(d, pos);
  if (!r) return null;
  const half = Math.floor(r[0] / 2);
  return [r[0] % 2 ? -half - 1 : half, r[1]];
}

export function version(d) {
  if (d.length < 9 || d[0] !== 0x6b || d[1] !== 0x69 || d[2] !== 0x77 || d[3] !== 0x69 || d[4] !== 0x62) return null;
  return u32(d, 5);
}

export function isKiwib(d) {
  return d.length >= 5 && d[0] === 0x6b && d[1] === 0x69 && d[2] === 0x77 && d[3] === 0x69 && d[4] === 0x62;
}

export function inflateV5(d) {
  const z = inflate(d.subarray(9));
  return z ? z.data : null;
}

export function isEmpty(d) {
  const v = version(d);
  if (v === 3 || v === 4) {
    const r = uleb(d, 9);
    return r ? r[0] === 0 : true;
  }
  if (v === 5) {
    const body = inflateV5(d);
    return body && body.length >= 28 ? i32(body, 24) <= 0 : true;
  }
  return true;
}

// v3/v4 records from offset 9, absolute coordinates; a truncated record ends the list.
function v34Records(d) {
  const c = uleb(d, 9);
  if (!c) return null;
  let [count, pos] = c;
  const out = [];
  for (let i = 0; i < count; i++) {
    const x = svarint(d, pos); if (!x) return null;
    const y = svarint(d, x[1]); if (!y) return null;
    const z = svarint(d, y[1]); if (!z) return null;
    pos = z[1];
    if (pos + 6 > d.length) break;
    out.push({ x: x[0], y: y[0], z: z[0], ty: u16(d, pos), b: d[pos + 2], g: d[pos + 3], r: d[pos + 4], w: d[pos + 5] });
    pos += 6;
  }
  return out;
}

// v5 tables over the inflated body: [header ints, grid-local voxels], null where malformed.
function v5Tables(body) {
  if (body.length < 32) return null;
  const h = [];
  for (let k = 0; k < 8; k++) h.push(i32(body, k * 4));
  const [, , , sx, , sz, count, start] = h;
  if (count < 0) return null;
  const n = count;
  const deltasEnd = 32 + 4 * Math.max(0, n - 1), typesEnd = deltasEnd + 2 * n, end = typesEnd + 4 * n;
  if (end > body.length) return null;
  if (n === 0) return [h, []];
  const plane = sx * sz;
  if (plane === 0 || sx === 0) return null;
  const out = new Array(n);
  let l = start;
  for (let i = 0; i < n; i++) {
    if (i > 0) l += i32(body, 32 + 4 * (i - 1));
    const rem = fmod(l, plane), c = u32(body, typesEnd + 4 * i);
    out[i] = {
      x: fmod(rem, sx), y: fdiv(l, plane), z: fdiv(rem, sx),
      r: (c >>> 16) & 255, g: (c >>> 8) & 255, b: c & 255, w: c >>> 24,
      ty: u16(body, deltasEnd + 2 * i),
    };
  }
  return [h, out];
}

export function materialFor(r, g, b, w, t) {
  if (!AUTHORED.has(t) && Math.max(r, g, b) <= 24) {
    [r, g, b] = { 1: [150, 130, 100], 2: [40, 170, 0], 3: [120, 120, 120], 4: [110, 78, 165], 79: [185, 194, 197],
      100: [220, 222, 225], 174: [232, 33, 70] }[t] || [110, 110, 110];
  }
  const kind = t === 55 ? 2 : t === 56 ? 3 : (t === 18 || t === 54) ? 1 : 0;
  const wc = Math.min(w, 7);
  return { r, g, b, kind, level: (kind === 1 || kind === 3) ? 16 + 32 * wc : 255, spec: kind === 0 ? wc : 0 };
}

// Every voxel in absolute grid coordinates (v5 keeps its origin, no mirroring), with
// materials. `payload` is the whole file for v3/v4, the inflated body for v5.
export function grid(ver, payload) {
  let voxels, origin = [0, 0, 0];
  if (ver === 3 || ver === 4) {
    voxels = v34Records(payload);
    if (!voxels) return null;
  } else if (ver === 5) {
    const t = v5Tables(payload);
    if (!t) return null;
    voxels = t[1]; origin = [t[0][0], t[0][1], t[0][2]];
  } else return [];
  return voxels.map((v) => ({ x: origin[0] + v.x, y: origin[1] + v.y, z: origin[2] + v.z, ...materialFor(v.r, v.g, v.b, v.w, v.ty) }));
}

// Decode a whole file: null for "not a part" (empty, unknown), throws on a malformed one.
export function decodeCells(raw) {
  if (!isKiwib(raw) || isEmpty(raw)) return null;
  const v = version(raw);
  if (v === null) return null;
  let payload;
  if (v === 3 || v === 4) payload = raw;
  else if (v === 5) {
    payload = inflateV5(raw);
    if (!payload) throw new Error('zlib.error');
  } else return null;
  const cells = grid(v, payload);
  if (!cells) throw new Error('blueprint grid decode failed');
  return cells.length ? cells : null;
}

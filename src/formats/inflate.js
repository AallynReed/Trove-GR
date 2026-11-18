// zlib inflate with zlib's own semantics: corrupt data is null, a stream cut short
// returns what decoded so far (eof false), trailing bytes after the end are ignored.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class Truncated extends Error {}
class Corrupt extends Error {}

function table(lengths) {
  const counts = new Uint16Array(16), offs = new Uint16Array(16);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  let left = 1;
  for (let i = 1; i < 16; i++) {
    left = (left << 1) - counts[i];
    if (left < 0) throw new Corrupt('over-subscribed code');
  }
  for (let i = 1; i < 15; i++) offs[i + 1] = offs[i] + counts[i];
  const symbols = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return { counts, symbols };
}

let FIXED = null;
function fixed() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
  FIXED = [table(l), table(new Uint8Array(30).fill(5))];
  return FIXED;
}

class Out {
  constructor(n) { this.buf = new Uint8Array(Math.max(256, n)); this.len = 0; }
  need(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const b = new Uint8Array(cap); b.set(this.buf.subarray(0, this.len)); this.buf = b;
  }
  push(v) { this.need(1); this.buf[this.len++] = v; }
}

function adler32(d, n) {
  let a = 1, b = 0;
  for (let i = 0; i < n;) {
    const end = Math.min(n, i + 3800);
    for (; i < end; i++) { a += d[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function inflate(input) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  const out = new Out(src.length * 4);
  let pos = 0, bit = 0, bits = 0;
  const need = (n) => {
    while (bits < n) {
      if (pos >= src.length) throw new Truncated();
      bit |= src[pos++] << bits; bits += 8;
    }
  };
  const take = (n) => { need(n); const v = bit & ((1 << n) - 1); bit >>>= n; bits -= n; return v; };
  const decode = (t) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= take(1);
      const c = t.counts[len];
      if (code - c < first) return t.symbols[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Corrupt('bad code');
  };
  try {
    if (src.length < 2) throw new Truncated();
    const cmf = src[0], flg = src[1];
    if ((cmf & 15) !== 8 || (cmf >> 4) > 7 || ((cmf << 8) | flg) % 31 || (flg & 32)) return null;
    pos = 2;
    let last = 0;
    while (!last) {
      last = take(1);
      const type = take(2);
      if (type === 0) {
        bit = 0; bits = 0;
        if (pos + 4 > src.length) throw new Truncated();
        const len = src[pos] | (src[pos + 1] << 8), nlen = src[pos + 2] | (src[pos + 3] << 8);
        if ((len ^ 0xffff) !== nlen) return null;
        pos += 4;
        const have = Math.min(len, src.length - pos);
        out.need(have); out.buf.set(src.subarray(pos, pos + have), out.len); out.len += have; pos += have;
        if (have < len) throw new Truncated();
        continue;
      }
      if (type === 3) return null;
      let lit, dist;
      if (type === 1) [lit, dist] = fixed();
      else {
        const hlit = take(5) + 257, hdist = take(5) + 1, hclen = take(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = take(3);
        const clt = table(cl);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const s = decode(clt);
          if (s < 16) { lens[i++] = s; continue; }
          let rep, v = 0;
          if (s === 16) { if (!i) return null; v = lens[i - 1]; rep = 3 + take(2); }
          else if (s === 17) rep = 3 + take(3);
          else rep = 11 + take(7);
          if (i + rep > hlit + hdist) return null;
          lens.fill(v, i, i + rep); i += rep;
        }
        if (!lens[256]) return null;
        lit = table(lens.subarray(0, hlit)); dist = table(lens.subarray(hlit));
      }
      for (;;) {
        const s = decode(lit);
        if (s < 256) { out.push(s); continue; }
        if (s === 256) break;
        const li = s - 257;
        if (li >= 29) return null;
        const len = LEN_BASE[li] + take(LEN_EXTRA[li]);
        const di = decode(dist);
        if (di >= 30) return null;
        const d = DIST_BASE[di] + take(DIST_EXTRA[di]);
        if (d > out.len) return null;
        out.need(len);
        const b = out.buf;
        for (let k = 0; k < len; k++) { b[out.len] = b[out.len - d]; out.len++; }
      }
    }
    bit = 0; bits = 0;
    if (pos + 4 > src.length) throw new Truncated();
    const want = ((src[pos] << 24) | (src[pos + 1] << 16) | (src[pos + 2] << 8) | src[pos + 3]) >>> 0;
    if (want !== adler32(out.buf, out.len)) return null;
    return { data: out.buf.slice(0, out.len), eof: true };
  } catch (e) {
    if (e instanceof Truncated) return { data: out.buf.slice(0, out.len), eof: false };
    if (e instanceof Corrupt) return null;
    throw e;
  }
}

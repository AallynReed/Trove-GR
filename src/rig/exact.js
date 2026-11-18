// Float helpers that round exactly as the reference assembly does (numpy/BLAS).

const SPLIT = 134217729; // 2^27 + 1
const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);

function twoProd(a, b) {
  const p = a * b;
  let t = SPLIT * a; const ah = t - (t - a), al = a - ah;
  t = SPLIT * b; const bh = t - (t - b), bl = b - bh;
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
}

function twoSum(a, b) {
  const s = a + b, bb = s - a;
  return [s, (a - (s - bb)) + (b - bb)];
}

// a + b rounded to odd.
function addOdd(a, b) {
  const [s, e] = twoSum(a, b);
  if (e === 0 || !Number.isFinite(s)) return s;
  f64[0] = s;
  if ((u64[0] & 1n) === 1n) return s;
  // even mantissa with a remainder: step one ulp toward the remainder
  u64[0] += (e > 0) === (s > 0) ? 1n : -1n;
  return f64[0];
}

// Correctly rounded a * b + c (Boldo-Melquiond emulation via rounding to odd).
export function fma(a, b, c) {
  const [uh, ul] = twoProd(a, b);
  if (!Number.isFinite(uh)) return a * b + c;
  if (uh === 0 && ul === 0) return a * b + c;
  const [th, tl] = twoSum(c, uh);
  return th + addOdd(tl, ul);
}

export function roundHalfEven(x) {
  const r = Math.round(x);
  if (Math.abs(x - Math.trunc(x)) === 0.5) {
    const away = Math.trunc(x) + Math.sign(x);
    return away % 2 === 0 ? away : Math.trunc(x);
  }
  return r;
}

// numpy's pairwise_sum.
export function pairwise(a, lo = 0, n = a.length) {
  if (n < 8) {
    let r = 0;
    for (let i = 0; i < n; i++) r += a[lo + i];
    return r;
  }
  if (n <= 128) {
    const r = [];
    for (let j = 0; j < 8; j++) r.push(a[lo + j]);
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[lo + i + j];
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[lo + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwise(a, lo, n2) + pairwise(a, lo + n2, n - n2);
}

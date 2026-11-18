import test from 'node:test';
import assert from 'node:assert/strict';

// JSON text equality: the reference writes -0.0, which JSON round trips turn into 0
const sameJson = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
import { RigMap, nearestPath } from '../src/rig/bindings.js';
import { Rig, assembleParts, partAt, mergeSameAp, unbury, payload } from '../src/rig/rig.js';
import { resolveDrop, markerModel } from '../src/rig/session.js';
import { fma, roundHalfEven, pairwise } from '../src/rig/exact.js';
import { compact } from '../scripts/bindings.mjs';
import { readJson, b64, toJson, partJson, sortedEntries } from './helpers.js';

const ref = readJson('tests/fixtures/reference.json');
const rigs = new Map();
const rig = (n) => {
  if (!rigs.has(n)) {
    let r;
    try { r = new Rig(readJson(`public/rigs/${n}.rig.json`)); } catch { r = null; }
    rigs.set(n, r);
  }
  return rigs.get(n);
};
const blob = (n) => b64(ref.blobs[n]);
const model = (r, n, parts) => (parts.length ? toJson({ ...payload(r, n, parts), parts: parts.map(partJson) }) : null);

test('fma is correctly rounded', () => {
  const exact = (a, b, c) => {
    const [ma, ea] = decompose(a), [mb, eb] = decompose(b), [mc, ec] = decompose(c);
    const e = Math.min(ea + eb, ec);
    const sum = ((ma * mb) << BigInt(ea + eb - e)) + (mc << BigInt(ec - e));
    return nearly(sum, e, fma(a, b, c));
  };
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return (s / 4294967296 - 0.5) * 2 ** ((s % 40) - 20); };
  for (let i = 0; i < 20000; i++) assert.ok(exact(rnd(), rnd(), rnd()), `case ${i}`);
  assert.equal(fma(0.1, 10, -1), 5.551115123125783e-17);
});

function decompose(x) {
  if (x === 0) return [0n, 0];
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (exp) mant |= 1n << 52n;
  const sign = hi >>> 31 ? -1n : 1n;
  return [sign * mant, (exp || 1) - 1075];
}

// the double nearest to sum * 2^e (ties to even) must equal got
function nearly(sum, e, got) {
  const [gm, ge] = decompose(got);
  const scale = (m, from, to) => (from >= to ? m << BigInt(from - to) : null);
  const lo = Math.min(e, ge);
  const want = scale(sum, e, lo), have = scale(gm, ge, lo);
  const diff = want - have;
  const ulp = 1n << BigInt(Math.max(0, ge - lo));
  const abs = diff < 0n ? -diff : diff;
  return abs * 2n < ulp || (abs * 2n === ulp && (gm & 1n) === 0n);
}

test('rounding and pairwise sums follow numpy', () => {
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, -2.6].map(roundHalfEven), [0, 2, 2, -0, -2, 2, -3]);
  const a = Array.from({ length: 300 }, (_, i) => 0.1 * (i % 13) - 0.37);
  assert.equal(pairwise(a.slice(0, 5)), a.slice(0, 5).reduce((x, y) => x + y, 0));
  assert.ok(Math.abs(pairwise(a) - a.reduce((x, y) => x + y, 0)) < 1e-12);
});

test('head attach points come from the skeleton', () => {
  for (const [name, want] of Object.entries(ref.head_aps)) {
    assert.deepEqual([...(rig(name)?.headAps || [])].sort(), want, name);
  }
});

test('the binding map resolves, scales and finds prefabs like the reference', () => {
  const rm = new RigMap(ref.rows);
  ref.resolve.forEach((c, i) => {
    const [skel, attach] = rm.resolve(c[0]);
    assert.deepEqual([skel, attach], [c[1], c[2]], `resolve ${i}`);
    const sc = rm.scalesFor(attach, skel ? rig(skel) : null);
    assert.deepEqual([sc.head, sortedEntries(sc.parts)], [ref.scales_for[i][2], ref.scales_for[i][3]], `scales_for ${i}`);
  });
  for (const c of ref.creature_scales) {
    const sc = rm.creatureScales(c[0], rig);
    assert.deepEqual([sc.head, sortedEntries(sc.parts)], [c[1], c[2]], c[0]);
  }
  for (const c of ref.prefab_path) assert.deepEqual(rm.prefabPath(c[0]), [c[1], c[2]], c[0]);
  for (const c of ref.creature_for) assert.deepEqual(rm.creatureFor(c[0]) || [null, null, []], c.slice(1), c[0]);
});

test('the compact bindings rebuild the same map', () => {
  const a = new RigMap(ref.rows), b = RigMap.fromCompact(compact(ref.rows));
  for (const k of ['byBlueprint', 'owner', 'creatures', 'byPath', 'byStem', 'headScale', 'meshScale']) {
    assert.deepEqual([...b[k]], [...a[k]], k);
  }
});

test('the shipped bindings load', () => {
  const rm = RigMap.fromCompact(readJson('public/data/bindings.json'));
  assert.ok(rm.byBlueprint.size > 40000);
  assert.ok(rm.creatures.size > 5000);
});

test('nearestPath prefers the folders the prefab shares, then byte order', () => {
  const c = ['blueprints/npc/merchant/hat.blueprint', 'blueprints/skins/adventurer/hat.blueprint'];
  assert.equal(nearestPath(c, 'prefabs/skins/adventurer/adv_knight.binfab'), c[1]);
  assert.equal(nearestPath(c, ''), c[0]);
  assert.equal(nearestPath([], 'x'), null);
});

test('assembly matches the reference payloads', () => {
  for (const c of ref.assemble) {
    const r = rig(c.rig);
    const files = c.files.map((n) => [`blueprints/${n}.blueprint`, blob(n)]);
    const parts = assembleParts(r, files, new Map(Object.entries(c.overrides)), new Map(Object.entries(c.scales)));
    sameJson(model(r, c.rig, parts), c.model);
  }
  for (const c of ref.placements) {
    const r = rig(c.rig);
    let parts = c.placements.filter((p) => r.hasAp(p.ap)).map((p) => partAt(p.ap, blob(p.blob), p.scale)).filter(Boolean);
    if (parts.length) { parts = mergeSameAp(parts); unbury(parts, r); }
    sameJson(model(r, c.rig, parts), c.model);
  }
});

test('enclosed glowing parts move out exactly as the reference does, on every rig', () => {
  assert.ok(ref.unbury.length > 900);
  for (const [name, ap, ...want] of ref.unbury) {
    const parts = mergeSameAp([partAt(ap, blob('cube'), 1), partAt(ap, blob('glow'), 0.5)]);
    unbury(parts, rig(name));
    const g = parts[parts.length - 1];
    sameJson([g.x[0], g.y[0], g.z[0]], want, `${name} ${ap}`);
  }
});

test('dropped parts resolve end to end like the reference server', () => {
  const fx = readJson('tests/fixtures/assembly.json');
  const rm = new RigMap(fx.rows);
  for (const c of fx.cases) {
    const files = c.files.map((n) => [`mod/${n}.blueprint`, b64(fx.blobs[n])]);
    const res = resolveDrop(rm, files, rig);
    const sc = rm.scalesFor(res.attach, res.rig);
    assert.equal(res.skeleton, c.want.skeleton);
    assert.deepEqual(res.attach, c.want.attach);
    assert.equal(res.head, c.want.head);
    assert.deepEqual(sortedEntries(sc.parts), c.want.scales);
    sameJson(res.model ? { parts: res.model.parts.map(partJson) } : null, c.want.model, c.files.join());
  }
  const all = fx.cases[0];
  const res = resolveDrop(rm, all.files.map((n) => [`${n}.blueprint`, b64(fx.blobs[n])]), rig);
  const status = Object.fromEntries(res.report.map((r) => [r.basename, r.status]));
  assert.deepEqual(status, {
    fx_body: 'placed', fx_core: 'placed', 'fx_head_lvl2[gold]': 'placed', fx_arm: 'placed', fx_glass: 'placed',
    fx_empty: 'empty', fx_other: 'other', fx_unbound: 'unbound',
  });
  assert.equal(res.report.find((r) => r.basename === 'fx_head_lvl2[gold]').variant, 'fx_head');
});

test('marker models put one cube on every attach point', () => {
  const r = rig('adventurer');
  const m = markerModel(r, 'adventurer');
  assert.equal(m.parts.length, Object.keys(r.rest).length);
  assert.ok(m.parts.every((p) => p.x.length === 1 && p.kind[0] === 2));
});

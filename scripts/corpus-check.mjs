// Compare this repo's assembly with the reference server's golden fixture.
// Usage: node scripts/corpus-check.mjs <engine.json> [rigs dir]
import { readFileSync, existsSync } from 'node:fs';
import { RigMap } from '../src/rig/bindings.js';
import { Rig, assembleParts, partAt, mergeSameAp, unbury, payload } from '../src/rig/rig.js';

const [enginePath, rigDir = 'public/rigs'] = process.argv.slice(2);
if (!enginePath) { console.error('usage: node scripts/corpus-check.mjs <engine.json> [rigs dir]'); process.exit(2); }
const e = JSON.parse(readFileSync(enginePath, 'utf8'));
const blob = (n) => new Uint8Array(Buffer.from(e.blobs[n], 'base64'));
const rigs = new Map();
const rig = (n) => {
  if (!rigs.has(n)) {
    const f = `${rigDir}/${n}.rig.json`;
    rigs.set(n, existsSync(f) ? new Rig(JSON.parse(readFileSync(f, 'utf8'))) : null);
  }
  return rigs.get(n);
};

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fail++;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  console.log(`FAIL ${label} at ${i}\n  got  ${a.slice(Math.max(0, i - 80), i + 120)}\n  want ${b.slice(Math.max(0, i - 80), i + 120)}`);
};
const sorted = (m) => [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1));
const toJson = (p) => {
  const o = { name: p.name, x: p.x, y: p.y, z: p.z, rgb: p.rgb, kind: p.kind, level: p.level };
  if (p.spec) o.spec = p.spec;
  if (p.scale !== null) o.scale = p.scale;
  return o;
};
const model = (r, n, parts) => (parts.length ? { ...payload(r, n, parts), parts: parts.map(toJson) } : null);

const rm = new RigMap(e.rows);
const baked = (s) => (s ? rig(s) : null);
e.resolve.forEach((c, i) => {
  const [skel, attach] = rm.resolve(c[0]);
  check(`resolve ${i}`, [skel, attach], [c[1], c[2]]);
  const sc = rm.scalesFor(attach, baked(skel));
  check(`scales_for ${i}`, [sc.head, sorted(sc.parts)], [e.scales_for[i][2], e.scales_for[i][3]]);
});
e.creature_scales.forEach((c) => {
  const sc = rm.creatureScales(c[0], rig);
  check(`creature_scales ${c[0]}`, [sc.head, sorted(sc.parts)], [c[1], c[2]]);
});
e.prefab_path.forEach((c) => check(`prefab_path ${c[0]}`, rm.prefabPath(c[0]), [c[1], c[2]]));
e.creature_for.forEach((c) => check(`creature_for ${c[0]}`, rm.creatureFor(c[0]) || [null, null, []], c.slice(1)));
for (const c of e.assemble) {
  const r = rig(c.rig);
  const files = c.files.map((n) => [`blueprints/${n}.blueprint`, blob(n)]);
  const got = r ? model(r, c.rig, assembleParts(r, files, new Map(Object.entries(c.overrides)), new Map(Object.entries(c.scales)))) : null;
  check(`assemble ${c.rig} ${c.files}`, got, c.model);
}
for (const c of e.placements) {
  const r = rig(c.rig);
  let parts = [];
  for (const p of c.placements) {
    if (!r.hasAp(p.ap)) continue;
    const part = partAt(p.ap, blob(p.blob), p.scale);
    if (part && p.tint) continue;
    if (part) parts.push(part);
  }
  if (c.placements.some((p) => p.tint)) continue;
  if (parts.length) { parts = mergeSameAp(parts); unbury(parts, r); }
  check(`placements ${c.rig}`, model(r, c.rig, parts), c.model);
}
for (const [name, ap, ...want] of e.unbury) {
  const r = rig(name);
  const parts = [partAt(ap, blob('cube'), 1), partAt(ap, blob('glow'), 0.5)].filter(Boolean);
  const merged = mergeSameAp(parts);
  unbury(merged, r);
  const g = merged[merged.length - 1];
  check(`unbury ${name} ${ap}`, [g.x[0], g.y[0], g.z[0]], want);
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

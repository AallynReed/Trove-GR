// CSV export of the game's rig bindings -> public/data/bindings.json, ordered by (prefab, blueprint)
// in byte order as the reference server loads them: the first row for a blueprint wins.
// Usage: node scripts/bindings.mjs <rig_binding.csv> [out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines.shift().split(',');
  if (head.join(',') !== 'prefab,blueprint,skeleton,ap_key,mesh_scale,head_scale') throw new Error('unexpected header');
  return lines.map((l, i) => {
    const c = l.split(',');
    if (c.length !== 6) throw new Error(`row ${i + 2}: ${c.length} columns`);
    return [c[0], c[1], c[2], c[3], Number(c[4]), Number(c[5])];
  });
}

export function compact(rows) {
  const skeletons = [], si = new Map(), prefabs = [], pi = new Map(), out = [];
  for (const [prefab, bp, skel, ap, mesh, head] of rows) {
    if (!si.has(skel)) { si.set(skel, skeletons.length); skeletons.push(skel); }
    if (!pi.has(prefab)) { pi.set(prefab, prefabs.length); prefabs.push([prefab, si.get(skel), head]); }
    const p = prefabs[pi.get(prefab)];
    if (skeletons[p[1]] !== skel || p[2] !== head) throw new Error(`skeleton/head differs within ${prefab}`);
    out.push(mesh === 1 ? [pi.get(prefab), bp, ap] : [pi.get(prefab), bp, ap, mesh]);
  }
  return { v: 1, skeletons, prefabs, rows: out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [src, out = 'public/data/bindings.json'] = process.argv.slice(2);
  if (!src) { console.error('usage: node scripts/bindings.mjs <rig_binding.csv> [out.json]'); process.exit(2); }
  const rows = parseCsv(readFileSync(src, 'utf8'));  // keep the export order: the server reads ORDER BY prefab, blueprint under en_US collation
  const c = compact(rows);
  writeFileSync(out, JSON.stringify(c));
  console.log(`${rows.length} rows, ${c.prefabs.length} prefabs, ${c.skeletons.length} skeletons -> ${out}`);
}

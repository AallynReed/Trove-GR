// Writes <rigs>/index.json: every rig with its attach-point and clip counts.
// Usage: node scripts/rig-index.mjs [rigs dir]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function rigIndex(dir) {
  const rigs = readdirSync(dir).filter((n) => n.endsWith('.rig.json')).map((n) => n.slice(0, -9)).sort().map((name) => {
    const r = JSON.parse(readFileSync(`${dir}/${name}.rig.json`, 'utf8'));
    return { name, aps: Object.keys(r.rest || {}).length, clips: Object.keys(r.animations || {}).length };
  });
  return { rigs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] || 'public/rigs';
  const idx = rigIndex(dir);
  writeFileSync(`${dir}/index.json`, JSON.stringify(idx) + '\n');
  console.log(`${idx.rigs.length} rigs -> ${dir}/index.json`);
}

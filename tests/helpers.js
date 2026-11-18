import { readFileSync } from 'node:fs';

export const root = new URL('../', import.meta.url);
export const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, root), 'utf8'));
export const readBytes = (rel) => new Uint8Array(readFileSync(new URL(rel, root)));
export const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
export const toJson = (v) => JSON.parse(JSON.stringify(v));

export const partJson = (p) => {
  const o = { name: p.name, x: p.x, y: p.y, z: p.z, rgb: p.rgb, kind: p.kind, level: p.level };
  if (p.spec) o.spec = p.spec;
  if (p.scale !== null) o.scale = p.scale;
  return o;
};
export const sortedEntries = (m) => [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1));

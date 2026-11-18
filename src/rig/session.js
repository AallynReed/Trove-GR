// What to place, and where: dropped parts resolved through the bindings, or a game prefab.
import { decodeCells } from '../formats/blueprint.js';
import { assembleParts, basenameOf, payload } from './rig.js';
import { nearestPath } from './bindings.js';

const isBlueprint = (p) => p.toLowerCase().endsWith('.blueprint');

// files: [[path, bytes]]. getRig(name) -> Rig | null (null: no baked rig for that skeleton).
export function resolveDrop(rigMap, files, getRig) {
  const bps = files.filter(([p]) => isBlueprint(p));
  const names = bps.map(([p]) => basenameOf(p));
  const [skeleton, attach] = rigMap.resolve(names);
  const rig = skeleton ? getRig(skeleton) : null;
  const scales = rigMap.scalesFor(attach, rig);
  const ap = new Map(attach);
  let model = null;
  if (rig) {
    const parts = assembleParts(rig, bps, ap, scales.parts);
    if (parts.length) model = payload(rig, skeleton, parts);
  }
  const report = bps.map(([path, raw]) => {
    const b = basenameOf(path), row = { path, basename: b };
    const key = rigMap.known(b);
    if (key === null) return { ...row, status: 'unbound', detail: 'Not in the game\'s bindings' };
    if (!ap.has(b)) return { ...row, status: 'other', detail: `Binds to ${rigMap.byBlueprint.get(key)[0]}` };
    const at = ap.get(b);
    if (!rig) return { ...row, status: 'norig', ap: at, detail: `${skeleton} has no baked rig` };
    if (!rig.hasAp(at)) return { ...row, status: 'noap', ap: at, detail: `${skeleton} has no attach point ${at}` };
    let empty;
    try { empty = !decodeCells(raw); } catch (e) { return { ...row, status: 'error', ap: at, detail: e.message }; }
    if (empty) return { ...row, status: 'empty', ap: at, detail: 'No voxels' };
    return { ...row, status: 'placed', ap: at, scale: scales.parts.has(b) ? scales.parts.get(b) : 1, variant: key !== b ? key : null };
  });
  return { skeleton, rig, attach, head: scales.head, model, report };
}

// gameIndex: Map '<name>.blueprint' (lowercase) -> [paths]; read(path) -> Promise<bytes>.
export async function resolvePrefab(rigMap, prefab, gameIndex, read, getRig) {
  const [skeleton, bound] = rigMap.creatureByPrefab(prefab);
  const rig = skeleton ? getRig(skeleton) : null;
  const files = [], report = [];
  for (const [basename, ap] of bound) {
    const path = nearestPath(gameIndex.get(`${basename}.blueprint`.toLowerCase()) || [], prefab);
    if (!path) { report.push({ path: null, basename, ap, status: 'missing', detail: 'Not in the opened game folder' }); continue; }
    const raw = await read(path);
    files.push([`${basename}.blueprint`, raw]);
    let cells;
    try { cells = decodeCells(raw); } catch (e) { report.push({ path, basename, ap, status: 'error', detail: e.message }); continue; }
    if (!cells) report.push({ path, basename, ap, status: 'empty', detail: 'No voxels' });
    else if (rig && !rig.hasAp(ap)) report.push({ path, basename, ap, status: 'noap', detail: `${skeleton} has no attach point ${ap}` });
    else report.push({ path, basename, ap, status: 'placed' });
  }
  let model = null;
  if (rig && files.length) {
    const scales = rigMap.creatureScales(prefab, getRig);
    const parts = assembleParts(rig, files, new Map(bound), scales.parts);
    if (parts.length) model = payload(rig, skeleton, parts);
    for (const r of report) if (r.status === 'placed') r.scale = scales.parts.has(r.basename) ? scales.parts.get(r.basename) : 1;
  }
  return { skeleton, rig, model, report };
}

// Attach points as small glowing cubes, for browsing a rig's clips with nothing dropped.
export function markerModel(rig, name) {
  const parts = Object.keys(rig.rest).map((ap) => ({
    name: ap, x: [0], y: [0], z: [0],
    rgb: [rig.isHeadAp(ap) ? 0x8fb3ff : 0xf5a623], kind: [2], level: [255], spec: null, scale: 1.5, shifted: false,
  }));
  return payload(rig, name, parts);
}

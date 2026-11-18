// The game's prefab bindings: which skeleton and attach point each blueprint uses.
import { scaleFor } from './rig.js';

const STYLE_RE = /\[[^\]]*\]/g;
const TIER_RE = /_lvl\d+/g;

// Python str.strip(): Unicode whitespace plus the separators 0x1c-0x1f and 0x85.
const PY_SPACE = (c) => /\s/u.test(c) || (c >= '\u001c' && c <= '\u001f') || c === '\u0085';
function pyStrip(s) {
  const chars = [...s];
  let a = 0, b = chars.length;
  while (a < b && PY_SPACE(chars[a])) a++;
  while (b > a && PY_SPACE(chars[b - 1])) b--;
  return chars.slice(a, b).join('');
}
const trimUnderscores = (s) => s.replace(/^_+|_+$/g, '');

export function prefabStem(prefab) {
  const name = prefab.replace(/\\/g, '/').split('/').pop();
  if (!name.toLowerCase().endsWith('.binfab')) return name;
  const chars = [...name];
  return chars.slice(0, Math.max(0, chars.length - 7)).join('');
}

// rows: [prefab, blueprint, skeleton, ap, meshScale, headScale] in the game's order.
export class RigMap {
  constructor(rows) {
    this.byBlueprint = new Map();
    this.owner = new Map();
    this.creatures = new Map();
    this.byPath = new Map();
    this.byStem = new Map();
    this.headScale = new Map();
    this.meshScale = new Map();
    for (const [prefab, blueprint, skeleton, ap, mesh, head] of rows) {
      if (!this.byBlueprint.has(blueprint)) this.byBlueprint.set(blueprint, [skeleton, ap]);
      if (!this.owner.has(blueprint)) this.owner.set(blueprint, prefab);
      if (!this.creatures.has(prefab)) {
        this.creatures.set(prefab, [skeleton, []]);
        this.byPath.set(prefab.replace(/\\/g, '/').toLowerCase(), prefab);
        const stem = prefabStem(prefab).toLowerCase();
        if (!this.byStem.has(stem)) this.byStem.set(stem, []);
        this.byStem.get(stem).push(prefab);
        this.headScale.set(prefab, head);
      }
      const parts = this.creatures.get(prefab)[1];
      const slot = parts.find((p) => p[0] === blueprint);
      if (slot) slot[1] = ap; else parts.push([blueprint, ap]);
      if (mesh !== 1) this.meshScale.set(prefab + '\0' + blueprint, mesh);
    }
  }

  static fromCompact(c) {
    return new RigMap(c.rows.map(([p, bp, ap, mesh]) => {
      const [prefab, s, head] = c.prefabs[p];
      return [prefab, bp, c.skeletons[s], ap, mesh ?? 1, head];
    }));
  }

  get empty() { return this.byBlueprint.size === 0; }

  // Strip only [style] and _lvlN suffixes, and only onto names the map already binds.
  matchVariant(basename) {
    const seen = new Set([basename]);
    const styled = basename.replace(STYLE_RE, '');
    for (let cand of [styled, basename.replace(TIER_RE, ''), styled.replace(TIER_RE, '')]) {
      cand = trimUnderscores(pyStrip(cand));
      if (!cand || seen.has(cand)) continue;
      seen.add(cand);
      if (this.byBlueprint.has(cand)) return cand;
    }
    return null;
  }

  known(basename) {
    return this.byBlueprint.has(basename) ? basename : this.matchVariant(basename);
  }

  // Majority-vote skeleton over the parts; [skeleton|null, [[basename, ap]]].
  resolve(basenames) {
    if (this.empty) return [null, []];
    const hits = [];
    for (const b of basenames) {
      const key = this.known(b);
      if (key === null) continue;
      const hit = this.byBlueprint.get(key);
      const slot = hits.find((h) => h[0] === b);
      if (slot) slot[1] = hit; else hits.push([b, hit]);
    }
    if (!hits.length) return [null, []];
    const counts = [];
    for (const [, [skel]] of hits) {
      const c = counts.find((x) => x[0] === skel);
      if (c) c[1]++; else counts.push([skel, 1]);
    }
    const best = Math.max(...counts.map((c) => c[1]));
    const skeleton = counts.find((c) => c[1] === best)[0];
    return [skeleton, hits.filter(([, [s]]) => s === skeleton).map(([b, [, ap]]) => [b, ap])];
  }

  creatureByPrefab(prefab) {
    const c = this.creatures.get(prefab.replace(/\\/g, '/'));
    return c ? [c[0], c[1].map((p) => p.slice())] : [null, []];
  }

  scales(rig, attach, owners) {
    const heads = [];
    for (const [, [prefab]] of owners) {
      const h = this.headScale.get(prefab) ?? 1;
      const slot = heads.find((x) => x[0] === h);
      if (slot) slot[1]++; else heads.push([h, 1]);
    }
    const parts = new Map();
    for (const [b, [prefab, key]] of owners) {
      const a = attach.find((x) => x[0] === b);
      if (!a) continue;
      const head = this.headScale.get(prefab) ?? 1;
      const mesh = this.meshScale.get(prefab + '\0' + key) ?? 1;
      parts.set(b, scaleFor(a[1], rig, head, mesh));
    }
    const best = Math.max(0, ...heads.map((h) => h[1]));
    const top = heads.find((h) => h[1] === best);
    return { head: top ? top[0] : 1, parts };
  }

  scalesFor(attach, rig) {
    const owners = [];
    for (const [b] of attach) {
      const key = this.known(b);
      if (key !== null && this.owner.has(key)) owners.push([b, [this.owner.get(key), key]]);
    }
    return this.scales(rig, attach, owners);
  }

  creatureScales(prefab, rigFor) {
    prefab = prefab.replace(/\\/g, '/');
    const c = this.creatures.get(prefab);
    if (!c) return { head: 1, parts: new Map() };
    const [skel, parts] = c;
    return this.scales(rigFor(skel), parts, parts.map(([b]) => [b, [prefab, b]]));
  }

  // [canonical|null, candidates]: a full path, or a bare stem that names one prefab.
  prefabPath(name) {
    if (!this.creatures.size) return [null, []];
    let want = pyStrip(name.replace(/\\/g, '/')).replace(/^\/+/, '').toLowerCase();
    if (!want) return [null, []];
    if (!want.endsWith('.binfab')) want += '.binfab';
    if (this.byPath.has(want)) return [this.byPath.get(want), []];
    if (want.includes('/')) return [null, []];
    const cands = (this.byStem.get(want.slice(0, -7)) || []).slice();
    if (cands.length === 1) return [cands[0], []];
    return [null, cands.sort(byteCmp)];
  }

  creatureFor(basename) {
    const prefab = this.owner.get(basename);
    if (prefab === undefined) return null;
    const [skel, parts] = this.creatures.get(prefab);
    return [skel, prefab, parts.map((p) => p.slice())];
  }
}

export function byteCmp(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

// Of several game files with one name, the one sharing most folders with the prefab.
export function nearestPath(candidates, hint) {
  if (!candidates.length) return null;
  const min = (list) => list.reduce((a, b) => (byteCmp(b, a) < 0 ? b : a));
  if (candidates.length === 1 || !hint) return min(candidates);
  const segs = (p) => {
    const parts = p.replace(/\\/g, '/').toLowerCase().split('/');
    parts.pop();
    return parts.filter(Boolean);
  };
  const want = new Set(segs(hint));
  const score = (p) => new Set(segs(p).filter((s) => want.has(s))).size;
  return candidates.reduce((best, p) => {
    const d = score(p) - score(best);
    return d > 0 || (d === 0 && byteCmp(p, best) < 0) ? p : best;
  });
}

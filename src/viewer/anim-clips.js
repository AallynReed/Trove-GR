// Rig animation: clip decoding, the rig's state machine -> moves, the control bar, playback maths.

let styled = false;

function injectStyles() {
  if (styled) return;
  styled = true;
  const css =
    '.mv-bar{display:flex;flex-wrap:wrap;gap:7px;align-items:center;padding:10px 12px;border-top:1px solid var(--line,#232a33)}' +
    '.mv-btn{background:var(--raised,#1b2129);border:1px solid var(--line-strong,#2a323d);color:var(--text,#cdd6e0);border-radius:8px;padding:6px 12px;font-size:.82rem;cursor:pointer}' +
    '.mv-btn:hover{border-color:var(--accent,#f5a623)}.mv-btn.on{background:var(--accent-soft,rgba(245,166,35,.14));border-color:var(--accent,#f5a623);color:var(--text,#e6edf3)}' +
    '.mv-btn.mv-loading{opacity:.55;cursor:progress}' +
    '.mv-btn:focus-visible,.mv-cat:focus-visible{outline:2px solid var(--accent,#f5a623);outline-offset:1px}' +
    '.mv-hint{color:var(--text-3,#858c9c);font-size:.74rem;margin-left:auto;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.mv-cats,.mv-clips{display:flex;flex-wrap:wrap;gap:7px;align-items:center;flex:1 0 100%;min-width:0}' +
    '.mv-clips{max-height:min(5.6rem,26vh);overflow-y:auto;overscroll-behavior:contain}' +
    '.mv-cat{background:transparent;border:1px solid var(--line-strong,#2a323d);color:var(--text-2,#9aa4b2);border-radius:999px;padding:3px 11px;font-size:.75rem;cursor:pointer;display:inline-flex;gap:5px;align-items:center}' +
    '.mv-cat:hover{border-color:var(--accent,#f5a623);color:var(--text,#cdd6e0)}' +
    '.mv-cat.on{background:var(--accent-soft,rgba(245,166,35,.14));border-color:var(--accent,#f5a623);color:var(--text,#e6edf3)}' +
    '.mv-cat-n{opacity:.6;font-variant-numeric:tabular-nums}' +
    '.mv-sep{width:1px;height:18px;background:var(--line-strong,#2a323d);flex:0 0 auto}';
  const tag = document.createElement('style');
  tag.textContent = css;
  document.head.appendChild(tag);
}

// TANIM1 (pos + quat, 7 f32) or TANIM2 (pos + column-major 3x3, 12 f32) per attach point per frame.
export function decode(buf) {
  const dv = new DataView(buf);
  let magic = '';
  for (let i = 0; i < 6; i++) magic += String.fromCharCode(dv.getUint8(i));
  if (magic !== 'TANIM1' && magic !== 'TANIM2') throw new Error('bad animation clip');
  const stride = magic === 'TANIM2' ? 12 : 7;
  const apCount = dv.getUint32(8, true), frameCount = dv.getUint32(12, true);
  const fps = dv.getUint32(16, true), nb = dv.getUint32(20, true);
  const raw = new Uint8Array(buf, 24, nb);
  let s = '';
  for (let j = 0; j < nb; j++) s += String.fromCharCode(raw[j]);
  const keys = s.split('\0').filter(Boolean);
  const apIndex = {};
  keys.forEach((k, i) => { apIndex[k] = i; });
  return { fps, frameCount, apCount, apIndex, stride, data: new Float32Array(buf, 24 + nb, frameCount * apCount * stride) };
}

// Clip names read <stance>_<action>_<detail>; unmatched actions land in "Other".
const STANCES = ['unarmed_', 'ranged_', '1h_', '2h_'];
const CLIP_GROUPS = [
  ['Idle', ['idle', 'sleep', 'pose', 'sit', 'afk', 'bob', 'stand', 'breathe', 'wait']],
  ['Move', ['walk', 'run', 'jump', 'roll', 'swim', 'glide', 'fly', 'climb', 'dash', 'sprint', 'land', 'fall', 'turn',
    'strafe', 'charge', 'move', 'hover', 'crawl', 'slide', 'recall', 'leap', 'flip']],
  ['Mount', ['mount']],
  ['Combat', ['ability', 'melee', 'shoot', 'throw', 'attack', 'block', 'cast', 'mine', 'shockwave', 'damage', 'death',
    'die', 'hit', 'fling', 'instant', 'swing', 'stab', 'punch', 'kick', 'slam', 'rampage', 'multispit', 'breath']],
  ['Emote', ['emote', 'dance', 'wave', 'laugh', 'cry', 'shrug', 'taunt', 'bow', 'excite', 'point', 'clap', 'salute', 'prance']],
  ['Fishing', ['fishing']],
];
const OTHER = 'Other';

function stripStance(name) {
  for (const s of STANCES) if (name.indexOf(s) === 0) return name.slice(s.length);
  return name;
}

export function clipInfo(name) {
  const b = stripStance(name);
  for (const [group, toks] of CLIP_GROUPS) {
    for (const t of toks) if (b === t || b.indexOf(t + '_') === 0) return { group, token: t };
  }
  return { group: OTHER, token: null };
}

function groupRank(g) {
  const i = CLIP_GROUPS.findIndex((x) => x[0] === g);
  return i < 0 ? CLIP_GROUPS.length : i;
}

const NAMESPACE_TOKENS = { mount: 1, ability: 1, emote: 1, fishing: 1 };

export function clipLabel(name, token) {
  let b = stripStance(name).replace(/_/g, ' ');
  if (token && NAMESPACE_TOKENS[token] && b.indexOf(token + ' ') === 0) b = b.slice(token.length + 1);
  return b;
}

// Moves from the rig's state machine: onloop edges chain, onrequest edges branch.
const STEP_WORDS = { begin: 1, cycle: 1, end: 1, start: 1, stop: 1, loop: 1, enter: 1, exit: 1, idle: 1 };

export function buildMoves(graph, have) {
  const nodes = graph && graph.nodes, edges = graph && graph.edges;
  if (!nodes || !edges) return [];
  function clipOf(id) {
    const n = nodes[id];
    if (!n) return null;
    const c = n.clip || (n.clips && n.clips.length === 1 ? n.clips[0] : null);
    return c && have[c] ? c : null;
  }
  // nested state machines repeat node names, so identity keys on the clip played
  const key = (id) => clipOf(id) || ('#' + id);
  const auto = {}, autoIn = {}, req = {}, reqFrom = {};
  edges.forEach((e) => {
    if (e.from == null || e.to == null || e.from === e.to) return;
    if (e.when === 'onloop') {
      if (!auto[e.from]) auto[e.from] = e;
      const k = key(e.to);
      autoIn[k] = (autoIn[k] || 0) + 1;
    } else if (e.when === 'onrequest') {
      (req[e.from] = req[e.from] || []).push(e);
      const t = key(e.to), f = key(e.from);
      if (!reqFrom[t]) reqFrom[t] = {};
      reqFrom[t][f] = 1;
    }
  });
  const isHub = (id) => !auto[id] && (autoIn[key(id)] || 0) >= 2;

  const chains = [];
  Object.keys(nodes).forEach((id) => {
    if (!auto[id] || autoIn[key(id)]) return;
    const seen = {}, path = [];
    let cur = id;
    while (cur != null) {
      const k = key(cur);
      if (seen[k]) { cur = null; break; }
      seen[k] = 1;
      const e = auto[cur];
      path.push({ id: cur, next: e ? (e.blend || 0) : 0 });
      if (!e) break;
      if (isHub(e.to) || seen[key(e.to)]) { cur = null; break; }
      cur = e.to;
    }
    if (cur == null || path.length < 2) return;
    chains.push({ park: cur, path, keys: seen });
  });
  chains.sort((a, b) => b.path.length - a.path.length);

  const used = {}, moves = [];
  chains.forEach((ch) => {
    const clips = [], blends = [];
    for (let i = 0; i < ch.path.length; i++) {
      const c = clipOf(ch.path[i].id);
      if (!c) return;
      if (used[ch.path[i].id]) return;
      clips.push(c);
      blends.push(i ? (ch.path[i - 1].next || 0) : 0);
    }
    const first = clipOf(ch.path[0].id);
    let enter = 0;
    edges.forEach((e) => {
      if (enter || e.when !== 'onrequest' || clipOf(e.to) !== first) return;
      if (isHub(e.from) || !enter) enter = e.blend || 0;
    });
    // Trove sets no PreferredExit, so an ending belongs to the move only if the move asks for it most
    const endKeys = {};
    const endings = (req[ch.park] || []).filter((e) => {
      const k = clipOf(e.to);
      if (!k || ch.keys[k] || endKeys[k] || used[e.to] || isHub(e.to)) return false;
      const from = Object.keys(reqFrom[k] || {});
      let inside = 0;
      from.forEach((f) => { if (ch.keys[f]) inside++; });
      if (inside * 2 <= from.length) return false;
      endKeys[k] = 1;
      return true;
    });
    const made = [];
    if (!endings.length) made.push({ clips: clips.slice(), blends: blends.slice(), enter, ids: [] });
    else endings.forEach((e) => made.push({ clips: clips.concat([clipOf(e.to)]), blends: blends.concat([e.blend || 0]), enter, ids: [e.to] }));
    made.forEach((m) => { m.label = moveLabel(m.clips); moves.push(m); });
    ch.path.forEach((s) => { used[s.id] = 1; });
    made.forEach((m) => m.ids.forEach((i) => { used[i] = 1; }));
  });
  const seenKey = {};
  return moves.filter((m) => {
    const k = m.clips.join('|');
    if (seenKey[k]) return false;
    seenKey[k] = 1;
    return true;
  });
}

function moveLabel(clips) {
  const toks = clips.map((c) => stripStance(c).split('_'));
  let stem = [];
  for (let i = 0; ; i++) {
    const t = toks[0][i];
    if (t === undefined || STEP_WORDS[t]) break;
    if (!toks.every((x) => x[i] === t)) break;
    stem.push(t);
  }
  if (!stem.length) stem = toks[0].slice(0, 1);
  const tail = toks[toks.length - 1].slice(stem.length).filter((t) => !STEP_WORDS[t]);
  return stem.join(' ') + (tail.length ? ' & ' + tail.join(' ') : '');
}

// One button = one program; clips a move claims stop being buttons of their own.
export function programs(have, graph) {
  const names = Array.isArray(have) ? have : Object.keys(have || {});
  const index = {};
  names.forEach((n) => { index[n] = 1; });
  const out = {}, entries = [], covered = {};
  (graph ? buildMoves(graph, index) : []).forEach((m) => {
    const key = 'move:' + m.clips.join('+');
    const blends = m.blends.slice();
    blends[0] = m.enter || 0;
    out[key] = { clips: m.clips, blends };
    entries.push({ key, name: m.clips[0], label: m.label });
    m.clips.forEach((c) => { covered[c] = 1; });
  });
  names.forEach((c) => {
    if (covered[c]) return;
    out[c] = { clips: [c], blends: [0] };
    entries.push({ key: c, name: c, label: null });
  });
  return { programs: out, entries };
}

const FLAT_MAX = 12;

// opts: { host, kit, onPick(key|null), restLabel, hint, onResize }
export function bar(opts) {
  injectStyles();
  const host = opts.host, entries = opts.kit.entries;
  const onResize = opts.onResize || (() => {});
  let active = null;
  host.textContent = '';
  host.classList.add('mv-bar');

  function mkBtn(parent, label, an) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mv-btn';
    b.textContent = label;
    b.dataset.anim = an;
    b.addEventListener('click', () => pick(an === 'rest' ? null : an));
    parent.appendChild(b);
    return b;
  }
  function pick(key) {
    setActive(key);
    if (opts.onPick) opts.onPick(key);
  }
  function setActive(key) {
    active = key;
    host.querySelectorAll('.mv-btn').forEach((b) => b.classList.toggle('on', b.dataset.anim === (key || 'rest')));
  }
  function setLoading(key, on) {
    const b = host.querySelector('.mv-btn[data-anim="' + CSS.escape(key) + '"]');
    if (b) b.classList.toggle('mv-loading', !!on);
  }
  const entryLabel = (e, token) => e.label || clipLabel(e.name, token);

  let hintHost = host;
  if (entries.length <= FLAT_MAX) {
    mkBtn(host, opts.restLabel || 'Rest pose', 'rest');
    entries.forEach((e) => mkBtn(host, entryLabel(e, null), e.key));
  } else {
    const buckets = {}, groups = [];
    entries.forEach((e) => {
      const g = clipInfo(e.name).group;
      if (!buckets[g]) { buckets[g] = []; groups.push(g); }
      buckets[g].push(e);
    });
    groups.sort((a, b) => groupRank(a) - groupRank(b));
    const cats = document.createElement('div');
    cats.className = 'mv-cats';
    const clips = document.createElement('div');
    clips.className = 'mv-clips';
    clips.setAttribute('role', 'group');
    clips.setAttribute('aria-label', 'Animation clips');
    host.appendChild(cats);
    host.appendChild(clips);
    mkBtn(cats, opts.restLabel || 'Rest pose', 'rest');
    const sep = document.createElement('span');
    sep.className = 'mv-sep';
    sep.setAttribute('aria-hidden', 'true');
    cats.appendChild(sep);
    const showGroup = (g) => {
      clips.textContent = '';
      buckets[g].forEach((e) => mkBtn(clips, entryLabel(e, clipInfo(e.name).token), e.key));
      onResize();
      cats.querySelectorAll('.mv-cat').forEach((b) => {
        const on = b.dataset.cat === g;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      setActive(active);
    };
    groups.forEach((g) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mv-cat';
      b.dataset.cat = g;
      b.setAttribute('aria-pressed', 'false');
      b.appendChild(document.createTextNode(g + ' '));
      const n = document.createElement('span');
      n.className = 'mv-cat-n';
      n.textContent = buckets[g].length;
      b.appendChild(n);
      b.addEventListener('click', () => showGroup(g));
      cats.appendChild(b);
    });
    showGroup(groups[0]);
    hintHost = cats;
  }
  if (opts.hint) {
    const hint = document.createElement('span');
    hint.className = 'mv-hint';
    hint.textContent = opts.hint;
    hintHost.appendChild(hint);
  }
  setActive(null);
  return { setActive, setLoading, host };
}

// A program's clips on one looping timeline, overlapping by each cross-fade (capped at half a clip).
export function timeline(spec, loaded) {
  if (!spec) return null;
  const A = [];
  for (const name of spec.clips) {
    const c = loaded[name];
    if (!c || !c.frameCount) return null;
    A.push(c);
  }
  const n = A.length, dur = A.map((x) => x.frameCount / x.fps);
  const blends = [], starts = [0];
  for (let i = 0; i < n; i++) {
    const prev = dur[(i - 1 + n) % n];
    blends.push(n < 2 ? 0 : Math.max(0, Math.min(spec.blends[i] || 0, dur[i] / 2, prev / 2)));
  }
  for (let i = 1; i < n; i++) starts[i] = starts[i - 1] + dur[i - 1] - blends[i];
  return { A, dur, blends, starts, total: starts[n - 1] + dur[n - 1] - blends[0] };
}

export function frameAt(prog, t) {
  const n = prog.A.length;
  t = ((t % prog.total) + prog.total) % prog.total;
  let i = n - 1;
  while (i > 0 && t < prog.starts[i]) i--;
  const cur = prog.A[i], local = t - prog.starts[i], b = prog.blends[i];
  if (n > 1 && b > 0 && local < b) {
    const p = (i - 1 + n) % n;
    const ps = i === 0 ? prog.starts[p] - prog.total : prog.starts[p];
    return { A: prog.A[p], f: (t - ps) * prog.A[p].fps, B: cur, g: local * cur.fps, u: local / b };
  }
  return { A: cur, f: local * cur.fps, B: null, g: 0, u: 0 };
}

function readPose(A, ai, frame, out) {
  const st = A.stride, o = (frame * A.apCount + ai) * st, d = A.data;
  out.p[0] = d[o]; out.p[1] = d[o + 1]; out.p[2] = d[o + 2];
  if (st === 12) {
    if (!out.m) out.m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 9; i++) out.m[i] = d[o + 3 + i];
  } else {
    out.m = null;
    out.q[0] = d[o + 3]; out.q[1] = d[o + 4]; out.q[2] = d[o + 5]; out.q[3] = d[o + 6];
  }
}

// Frames lerp to the display rate; the next frame wraps because playback loops.
function sampleOne(A, ai, f, out) {
  const n = A.frameCount, f0 = Math.floor(f), a = f - f0;
  readPose(A, ai, f0 % n, out);
  if (a) {
    readPose(A, ai, (f0 + 1) % n, _next);
    lerpInto(out, _next, a);
  }
  return out;
}

export function quatToMat(q, m) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  m[0] = 1 - (yy + zz); m[1] = xy + wz; m[2] = xz - wy;
  m[3] = xy - wz; m[4] = 1 - (xx + zz); m[5] = yz + wx;
  m[6] = xz + wy; m[7] = yz - wx; m[8] = 1 - (xx + yy);
}

const _mB = [0, 0, 0, 0, 0, 0, 0, 0, 0];

function lerpInto(out, b, a) {
  out.p[0] += (b.p[0] - out.p[0]) * a;
  out.p[1] += (b.p[1] - out.p[1]) * a;
  out.p[2] += (b.p[2] - out.p[2]) * a;
  if (out.m || b.m) {
    if (!out.m) { out.m = [0, 0, 0, 0, 0, 0, 0, 0, 0]; quatToMat(out.q, out.m); }
    let bm = b.m;
    if (!bm) { bm = _mB; quatToMat(b.q, bm); }
    for (let k = 0; k < 9; k++) out.m[k] += (bm[k] - out.m[k]) * a;
    return;
  }
  const dot = out.q[0] * b.q[0] + out.q[1] * b.q[1] + out.q[2] * b.q[2] + out.q[3] * b.q[3];
  const s = dot < 0 ? -1 : 1;
  for (let i = 0; i < 4; i++) out.q[i] += (s * b.q[i] - out.q[i]) * a;
  const len = Math.hypot(out.q[0], out.q[1], out.q[2], out.q[3]) || 1;
  for (let j = 0; j < 4; j++) out.q[j] /= len;
}

const _scratch = { p: [0, 0, 0], q: [0, 0, 0, 1], m: null };
const _other = { p: [0, 0, 0], q: [0, 0, 0, 1], m: null };
const _next = { p: [0, 0, 0], q: [0, 0, 0, 1], m: null };

// Pose of one attach point at a frameAt() moment; returns a shared object.
export function sample(at, apKey) {
  const ai = at.A.apIndex[apKey];
  if (ai === undefined) return null;
  sampleOne(at.A, ai, at.f, _scratch);
  if (at.B) {
    const bi = at.B.apIndex[apKey];
    if (bi !== undefined) {
      sampleOne(at.B, bi, at.g, _other);
      lerpInto(_scratch, _other, at.u);
    }
  }
  return _scratch;
}

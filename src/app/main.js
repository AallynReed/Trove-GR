import './styles.css';
import { h, formatCount } from './dom.js';
import { icon } from './icons.js';
import { VERSION } from '../version.js';
import { RigMap, prefabStem } from '../rig/bindings.js';
import { Rig, basenameOf } from '../rig/rig.js';
import { resolveDrop, resolvePrefab, markerModel } from '../rig/session.js';
import { readTmod } from '../formats/tmod.js';
import { mount } from '../viewer/model-viewer.js';
import { builtinRigs, folderRigs, entriesFromFiles, entriesFromDrop, bytesOf } from '../io/sources.js';

const BASE = import.meta.env.BASE_URL;
const AUTO_ASSEMBLE_MAX = 300;
const $ = (id) => document.getElementById(id);
const app = $('app');

const state = {
  source: builtinRigs(BASE),
  rigs: [],
  rigCache: new Map(),
  rigMap: null,
  tab: 'rigs',
  selected: null,
  drop: null,
  game: new Map(),
  view: null,
  viewer: null,
};

// ---- chrome ----

$('version-chip').textContent = 'v' + VERSION;
$('open-files').innerHTML = icon('file') + '<span>Open parts</span>';
$('open-folder').innerHTML = icon('folder') + '<span>Open folder</span>';
$('open-rigs').innerHTML = icon('list') + '<span>Rigs folder</span>';
$('empty-files').innerHTML = icon('file') + '<span>Open parts</span>';
$('empty-folder').innerHTML = icon('folder') + '<span>Open folder</span>';
$('toggle-inspector').innerHTML = icon('panel');
$('toggle-sidebar').innerHTML = icon('list');
$('search-icon').innerHTML = icon('search');

for (const [btn, input] of [['open-files', 'files-input'], ['empty-files', 'files-input'], ['open-folder', 'folder-input'], ['empty-folder', 'folder-input'], ['open-rigs', 'rigs-input']]) {
  $(btn).addEventListener('click', () => $(input).click());
}
$('files-input').addEventListener('change', (e) => { openEntries(entriesFromFiles(e.target.files)); e.target.value = ''; });
$('folder-input').addEventListener('change', (e) => { openEntries(entriesFromFiles(e.target.files)); e.target.value = ''; });
$('rigs-input').addEventListener('change', (e) => { openRigFolder(entriesFromFiles(e.target.files)); e.target.value = ''; });
if (window.innerWidth < 1100) {
  app.classList.add('no-inspector');
  $('toggle-inspector').setAttribute('aria-pressed', 'false');
}
$('toggle-inspector').addEventListener('click', () => {
  const off = app.classList.toggle('no-inspector');
  $('toggle-inspector').setAttribute('aria-pressed', String(!off));
});
$('toggle-sidebar').addEventListener('click', () => {
  const open = app.classList.toggle('sidebar-open');
  $('toggle-sidebar').setAttribute('aria-expanded', String(open));
});

let toastTimer = 0;
function toast(msg, kind = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.dataset.kind = kind;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}
const setStatus = (text) => { $('status').textContent = text || ''; };

// drop anywhere
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('drop-overlay').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0; $('drop-overlay').hidden = true;
  openEntries(entriesFromDrop(e.dataTransfer));
});

// ---- data ----

async function getRigAsync(name) {
  if (state.rigCache.has(name)) return state.rigCache.get(name);
  let rig = null;
  if (state.rigs.some((r) => r.name === name)) rig = new Rig(await state.source.rig(name));
  state.rigCache.set(name, rig);
  return rig;
}
const getRig = (name) => state.rigCache.get(name) ?? null;

async function loadBindings() {
  const res = await fetch(BASE + 'data/bindings.json');
  if (!res.ok) throw new Error(`could not load the bindings (HTTP ${res.status})`);
  state.rigMap = RigMap.fromCompact(await res.json());
}

async function loadRigList() {
  state.rigs = await state.source.index();
  state.rigCache.clear();
  renderList();
}

async function openRigFolder(entriesP) {
  try {
    state.source = folderRigs(await entriesP);
    await loadRigList();
    toast(`Using ${state.rigs.length} rigs from ${state.source.label}`);
    if (state.drop) await showDrop();
    else if (state.selected) await showRig(state.selected);
  } catch (e) { toast(e.message, 'error'); }
}

// ---- opening parts ----

async function openEntries(entriesP) {
  let entries;
  try { entries = await entriesP; } catch (e) { toast(e.message, 'error'); return; }
  const bps = entries.filter((e) => e.path.toLowerCase().endsWith('.blueprint'));
  const tmods = entries.filter((e) => e.path.toLowerCase().endsWith('.tmod'));
  if (!bps.length && !tmods.length) { toast('No .blueprint or .tmod files in there.', 'warn'); return; }
  // every blueprint also becomes the pool that game creatures assemble from
  for (const e of bps) {
    const name = e.path.split('/').pop().toLowerCase();
    if (!state.game.has(name)) state.game.set(name, []);
    const list = state.game.get(name);
    if (!list.some((x) => x.path === e.path)) list.push(e);
  }
  if (bps.length > AUTO_ASSEMBLE_MAX && !tmods.length) {
    toast(`${formatCount(bps.length)} blueprints opened. Pick a creature to assemble from them.`);
    setTab('creatures');
    renderList();
    return;
  }
  setStatus('Reading parts…');
  try {
    const files = [];
    const loose = bps.slice().sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1));
    for (const e of loose) files.push([e.path, await bytesOf(e)]);
    for (const t of tmods) {
      let mod;
      try { mod = readTmod(await bytesOf(t)); } catch (err) { toast(`${t.path.split('/').pop()}: ${err.message}`, 'error'); continue; }
      for (const f of mod.files) files.push([f.path, f.data]);
    }
    state.drop = { name: dropName(entries), files };
    await showDrop();
  } catch (e) {
    setStatus('');
    toast(e.message, 'error');
  }
}

function dropName(entries) {
  if (entries.length === 1) return entries[0].path.split('/').pop();
  const top = entries[0].path.split('/')[0];
  return entries.every((e) => e.path.startsWith(top + '/')) ? top : `${entries.length} files`;
}

async function showDrop() {
  const { files, name } = state.drop;
  const names = files.filter(([p]) => p.toLowerCase().endsWith('.blueprint')).map(([p]) => p);
  const pre = state.rigMap.resolve(names.map(basenameOf));
  if (pre[0]) await getRigAsync(pre[0]);
  let res;
  try { res = resolveDrop(state.rigMap, files, getRig); } catch (e) { toast(e.message, 'error'); setStatus(''); return; }
  state.selected = res.skeleton;
  renderList();
  show({ kind: 'drop', title: name, ...res });
}

async function showRig(name) {
  setStatus('Loading rig…');
  try {
    const rig = await getRigAsync(name);
    state.selected = name;
    renderList();
    show({ kind: 'rig', title: name, skeleton: name, rig, model: markerModel(rig, name), report: null });
  } catch (e) { toast(e.message, 'error'); setStatus(''); }
}

async function showPrefab(prefab) {
  const [skel] = state.rigMap.creatureByPrefab(prefab);
  if (!state.game.size) { toast('Open your extracted blueprints folder first, then pick the creature again.', 'warn'); return; }
  setStatus('Assembling…');
  try {
    if (skel) await getRigAsync(skel);
    const res = await resolvePrefab(state.rigMap, prefab, indexOfGame(), readGame, getRig);
    show({ kind: 'prefab', title: prefabStem(prefab), prefab, ...res });
  } catch (e) { toast(e.message, 'error'); setStatus(''); }
}

function indexOfGame() {
  const m = new Map();
  for (const [name, list] of state.game) m.set(name, list.map((e) => e.path));
  return m;
}
async function readGame(path) {
  const e = state.game.get(path.split('/').pop().toLowerCase()).find((x) => x.path === path);
  return bytesOf(e);
}

// ---- the viewer ----

async function show(view) {
  if (state.viewer) { state.viewer.dispose(); state.viewer = null; }
  state.view = view;
  app.classList.add('has-view');
  $('title').textContent = view.title;
  $('fatal').hidden = true;
  renderInspector();
  if (!view.model) {
    setStatus(view.kind === 'rig' ? '' : 'Nothing could be placed');
    $('viewer-bar').textContent = '';
    return;
  }
  setStatus('');
  const name = view.model.rig;
  const graph = await state.source.graph(name);
  if (state.view !== view) return;
  try {
    state.viewer = mount($('viewer-stage'), {
      data: view.model, graph, bar: $('viewer-bar'), title: view.title, brdfUrl: BASE + 'brdf-map.png',
      fetchClip: (clip) => state.source.clip(name, clip),
    });
  } catch (e) {
    $('fatal').hidden = false;
    $('fatal').textContent = 'This browser could not start WebGL, so the model cannot be drawn. ' + (e.message || '');
  }
}

// ---- sidebar list ----

function setTab(tab) {
  state.tab = tab;
  $('tab-rigs').setAttribute('aria-selected', String(tab === 'rigs'));
  $('tab-creatures').setAttribute('aria-selected', String(tab === 'creatures'));
  $('search').placeholder = tab === 'rigs' ? 'Filter rigs' : 'Filter creatures';
  $('list').setAttribute('aria-label', tab === 'rigs' ? 'Rigs' : 'Creatures');
  renderList();
}
$('tab-rigs').addEventListener('click', () => setTab('rigs'));
$('tab-creatures').addEventListener('click', () => setTab('creatures'));
$('search').addEventListener('input', () => renderList());
window.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('search')) { e.preventDefault(); $('search').focus(); }
});

const LIST_MAX = 400;
let prefabsBySkel = null;

function renderList() {
  const list = $('list');
  const q = $('search').value.trim().toLowerCase();
  list.textContent = '';
  if (state.tab === 'rigs') {
    if (!prefabsBySkel && state.rigMap) {
      prefabsBySkel = new Map();
      for (const [skel] of state.rigMap.creatures.values()) prefabsBySkel.set(skel, (prefabsBySkel.get(skel) || 0) + 1);
    }
    const rows = state.rigs.filter((r) => !q || r.name.includes(q));
    for (const r of rows) {
      const n = prefabsBySkel ? prefabsBySkel.get(r.name) || 0 : 0;
      const bits = [r.clips == null ? null : `${r.clips} clip${r.clips === 1 ? '' : 's'}`, r.aps == null ? null : `${r.aps} points`, n ? `${n} creature${n === 1 ? '' : 's'}` : null].filter(Boolean);
      list.append(row(r.name, bits.join(' · '), state.selected === r.name && state.view?.kind !== 'prefab', () => showRig(r.name)));
    }
    $('list-count').textContent = `${formatCount(rows.length)} of ${formatCount(state.rigs.length)} rigs · ${state.source.label}`;
  } else {
    const all = state.rigMap ? [...state.rigMap.creatures.keys()] : [];
    const rows = all.filter((p) => !q || p.toLowerCase().includes(q));
    for (const p of rows.slice(0, LIST_MAX)) {
      const skel = state.rigMap.creatures.get(p)[0];
      list.append(row(prefabStem(p), `${skel} · ${p.split('/').slice(1, -1).join('/')}`, state.view?.prefab === p, () => showPrefab(p)));
    }
    const more = rows.length > LIST_MAX ? ` (showing ${LIST_MAX}; filter to narrow)` : '';
    const pool = state.game.size ? `${formatCount(state.game.size)} blueprints open` : 'open a blueprints folder to assemble';
    $('list-count').textContent = `${formatCount(rows.length)} creatures${more} · ${pool}`;
  }
}

function row(name, sub, selected, onPick) {
  const el = h('div', { class: 'fx-row list-row', role: 'option', 'aria-selected': String(!!selected), tabindex: '-1' },
    h('div', { class: 'fx-text' }, h('span', { class: 'fx-name' }, name), h('span', { class: 'fx-dir' }, sub)));
  el.addEventListener('click', () => { onPick(); app.classList.remove('sidebar-open'); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } });
  return el;
}

$('list').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const rows = [...$('list').querySelectorAll('.list-row')];
  if (!rows.length) return;
  const i = rows.indexOf(document.activeElement);
  const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)))];
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
});

// ---- inspector ----

const STATUS_LABEL = { placed: 'Placed', unbound: 'Not bound', other: 'Other rig', norig: 'No rig', noap: 'No point', empty: 'Empty', error: 'Unreadable', missing: 'Missing' };

function renderInspector() {
  const v = state.view, ins = $('inspector');
  ins.textContent = '';
  if (!v) { ins.append(h('p', { class: 'inspector-empty' }, 'Pick a rig or open parts to see the details here.')); return; }
  const rig = v.rig;
  const kv = [];
  if (v.skeleton) kv.push(['Rig', v.skeleton]);
  if (v.prefab) kv.push(['Prefab', v.prefab]);
  if (rig) {
    kv.push(['Attach points', formatCount(Object.keys(rig.rest).length)]);
    kv.push(['Clips', formatCount(rig.animationNames().length)]);
    kv.push(['Voxel size', `1/${Math.round(1 / rig.voxelScale)}`]);
  }
  if (v.head && v.head !== 1) kv.push(['Head scale', String(v.head)]);
  if (v.model && v.kind !== 'rig') kv.push(['Voxels', formatCount(v.model.parts.reduce((a, p) => a + p.x.length, 0))]);
  ins.append(h('section', { class: 'panel-section' }, h('h2', { class: 'section-title' }, v.kind === 'rig' ? 'Rig' : 'Model'),
    h('div', { class: 'kv' }, kv.flatMap(([k, val]) => [h('span', { class: 'k' }, k), h('span', { class: 'v' }, val)]))));
  if (v.report) {
    const placed = v.report.filter((r) => r.status === 'placed'), rest = v.report.filter((r) => r.status !== 'placed');
    if (!v.skeleton) ins.append(h('section', { class: 'panel-section' }, h('p', { class: 'note note-tight' }, 'None of these parts are bound to a rig in the game, so nothing is placed.')));
    if (placed.length) ins.append(partSection(`Placed (${placed.length})`, placed));
    if (rest.length) ins.append(partSection(`Not placed (${rest.length})`, rest));
  } else if (rig) {
    const aps = Object.keys(rig.rest).sort();
    ins.append(h('section', { class: 'panel-section' }, h('h2', { class: 'section-title' }, 'Attach points'),
      h('p', { class: 'note note-tight' }, 'Orange cubes mark each point; blue ones sit on the head. Drop parts to see them placed.'),
      h('div', { class: 'chips' }, aps.map((a) => h('span', { class: 'chip-sm' }, a)))));
  }
}

function partSection(title, rows) {
  return h('section', { class: 'panel-section' }, h('h2', { class: 'section-title' }, title),
    h('ul', { class: 'layers' }, rows.map((r) => h('li', { class: 'layer' },
      h('div', { class: 'layer-head' }, h('span', { class: 'layer-name' }, r.basename), h('span', { class: 'count' }, r.status === 'placed' ? r.ap : STATUS_LABEL[r.status])),
      h('div', { class: 'chips' },
        r.status === 'placed' && r.scale != null && r.scale !== 1 ? h('span', { class: 'chip-sm' }, `scale ${+r.scale.toFixed(4)}`) : null,
        r.variant ? h('span', { class: 'chip-sm' }, `as ${r.variant}`) : null,
        r.detail ? h('span', { class: 'chip-sm chip-note' }, r.detail) : null)))));
}

// ---- test hooks ----

window.TroveGR = {
  state: () => (state.viewer ? state.viewer.state() : null),
  poseFrame: (name, frame) => (state.viewer ? state.viewer.poseFrame(name, frame) : null),
  play: (key) => (state.viewer ? state.viewer.play(key) : null),
  view: () => (state.view ? { kind: state.view.kind, skeleton: state.view.skeleton, report: state.view.report, model: state.view.model } : null),
  showRig,
  showPrefab,
  openRigFolder: (files) => openRigFolder(Promise.resolve(files.map((f) => ({ path: f.path, blob: async () => new Blob([f.data]) })))),
  openFiles: (files) => openEntries(Promise.resolve(files.map((f) => ({ path: f.path, blob: async () => new Blob([f.data]) })))),
};

// ---- start ----

renderInspector();
Promise.all([loadRigList(), loadBindings()])
  .then(() => renderList())
  .catch((e) => { $('fatal').hidden = false; $('fatal').textContent = e.message; });

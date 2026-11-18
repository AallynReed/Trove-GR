// File input: picked files, picked folders and drops become [{path, blob()}]; rig data
// comes from the built-in set or a folder the user picks. Nothing is uploaded.

const norm = (p) => p.replace(/\\/g, '/').replace(/^\/+/, '');

export function entriesFromFiles(files) {
  return Array.from(files).map((f) => ({ path: norm(f.webkitRelativePath || f.name), blob: async () => f }));
}

// Must be called synchronously inside the drop handler.
export function entriesFromDrop(dataTransfer) {
  const roots = [], loose = [];
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry) roots.push(entry);
    else { const f = item.getAsFile(); if (f) loose.push(f); }
  }
  if (!roots.length && !loose.length) return Promise.resolve(entriesFromFiles(dataTransfer.files || []));
  return (async () => {
    const out = entriesFromFiles(loose);
    const fileOf = (fe) => new Promise((resolve, reject) => fe.file(resolve, reject));
    const walk = async (entry, prefix) => {
      const path = prefix + entry.name;
      if (entry.isFile) { out.push({ path, blob: () => fileOf(entry) }); return; }
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, path + '/');
      }
    };
    for (const root of roots) await walk(root, '');
    return out;
  })();
}

export const bytesOf = async (entry) => new Uint8Array(await (await entry.blob()).arrayBuffer());

async function json(res, what) {
  if (!res.ok) throw new Error(`could not load ${what} (HTTP ${res.status})`);
  return res.json();
}

// The rigs shipped with the app, served next to it.
export function builtinRigs(base) {
  const url = (p) => base + 'rigs/' + p.split('/').map(encodeURIComponent).join('/');
  return {
    label: 'Built-in rigs',
    index: () => fetch(url('index.json')).then((r) => json(r, 'the rig list')).then((j) => j.rigs),
    rig: (name) => fetch(url(`${name}.rig.json`)).then((r) => json(r, `rig ${name}`)),
    graph: (name) => fetch(url(`graph/${name}.graph.json`)).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    clip: (rig, name) => fetch(url(`anim/${rig}/${name}.anim`)).then((r) => {
      if (!r.ok) throw new Error(`clip ${name} (HTTP ${r.status})`);
      return r.arrayBuffer();
    }),
  };
}

// A folder laid out like public/rigs: *.rig.json, anim/<rig>/<clip>.anim, graph/<rig>.graph.json.
export function folderRigs(entries) {
  const paths = entries.map((e) => e.path);
  const top = paths[0] && paths[0].includes('/') ? paths[0].split('/')[0] : '';
  const strip = top && paths.every((p) => p.startsWith(top + '/')) ? top.length + 1 : 0;
  const files = new Map(entries.map((e) => [e.path.slice(strip).toLowerCase(), e]));
  const read = (p) => files.get(p.toLowerCase());
  const text = async (e) => (await e.blob()).text();
  const names = [...files.keys()].filter((p) => !p.includes('/') && p.endsWith('.rig.json')).map((p) => p.slice(0, -9)).sort();
  if (!names.length) throw new Error('No *.rig.json files at the top of that folder.');
  return {
    label: top || 'Rigs folder',
    index: async () => {
      const idx = read('index.json');
      if (idx) { try { const j = JSON.parse(await text(idx)); if (Array.isArray(j.rigs)) return j.rigs; } catch { /* fall through */ } }
      return names.map((name) => ({ name, aps: null, clips: null }));
    },
    rig: async (name) => {
      const e = read(`${name}.rig.json`);
      if (!e) throw new Error(`rig ${name} is not in that folder`);
      return JSON.parse(await text(e));
    },
    graph: async (name) => {
      const e = read(`graph/${name}.graph.json`);
      try { return e ? JSON.parse(await text(e)) : null; } catch { return null; }
    },
    clip: async (rig, name) => {
      const e = read(`anim/${rig}/${name}.anim`);
      if (!e) throw new Error(`clip ${name} is not in that folder`);
      return (await e.blob()).arrayBuffer();
    },
  };
}

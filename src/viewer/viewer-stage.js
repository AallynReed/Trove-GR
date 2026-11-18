// Stage tools shared by the viewer: backdrop, sun control with guide rays, PNG snapshot.
import * as THREE from 'three';
import * as VM from '../render/voxel-mesh.js';

var STORE_KEY = 'trove-gr.viewerBg';        // { mode, color } - never the image itself
var LIGHT_KEY = 'trove-gr.viewerLight';     // { intensity, azimuth, elevation }; absent = the host's own
var GRAD_A = '#1b2531', GRAD_B = '#0c1118';   // fallbacks; the CSS vars are the source
var _styles = false;

var IMG = { url: '', name: '', el: null };
var _uid = 0;                             // one counter per page = ids that cannot collide

function injectStyles() {
  if (_styles) return; _styles = true;
  var css =
    '.vs-tools{position:absolute;top:8px;right:8px;z-index:3;display:flex;gap:6px}' +
    '.vs-slot{position:relative}' +
    '.vs-tool{position:relative;display:flex;align-items:center;gap:6px;background:rgba(16,21,28,.82);' +
      'border:1px solid #2a323d;color:#cdd6e0;border-radius:8px;padding:5px 9px;' +
      'font:inherit;font-size:.76rem;line-height:1.2;cursor:pointer}' +
    '.vs-tool:hover{border-color:var(--accent);color:#e6edf3}' +
    '.vs-tool:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
    '.vs-tool[aria-expanded="true"]{border-color:var(--accent);color:#e6edf3}' +
    '.vs-tool svg{width:14px;height:14px;flex:0 0 auto;fill:none;stroke:currentColor;' +
      'stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}' +
    '.vs-panel{position:absolute;top:calc(100% + 6px);right:0;z-index:4;width:212px;padding:11px;' +
      'background:#10151c;border:1px solid #2a323d;border-radius:10px;' +
      'box-shadow:0 14px 34px rgba(0,0,0,.5)}' +
    '.vs-panel[hidden]{display:none}' +
    '.vs-legend{display:block;color:#9aa4b2;font-size:.72rem;text-transform:uppercase;' +
      'letter-spacing:.06em;margin:0 0 7px}' +
    '.vs-opts{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 9px}' +
    '.vs-opt{background:transparent;border:1px solid #2a323d;color:#9aa4b2;border-radius:999px;' +
      'padding:4px 11px;font:inherit;font-size:.76rem;cursor:pointer}' +
    '.vs-opt:hover{border-color:var(--accent);color:#cdd6e0}' +
    '.vs-opt:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
    '.vs-opt[aria-pressed="true"]{background:var(--accent-soft);border-color:var(--accent);color:#e6edf3}' +
    '.vs-row{display:flex;align-items:center;gap:8px;color:#9aa4b2;font-size:.76rem}' +
    '.vs-row[hidden]{display:none}' +
    '.vs-row input[type=color]{width:34px;height:24px;padding:0;background:none;' +
      'border:1px solid #2a323d;border-radius:6px;cursor:pointer}' +
    '.vs-file{color:#9aa4b2;font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.vs-clear{background:none;border:0;color:#8a93a3;font:inherit;font-size:.72rem;' +
      'text-decoration:underline;cursor:pointer;padding:0;margin-left:auto;flex:0 0 auto}' +
    '.vs-clear:hover{color:#e6edf3}' +
    '.vs-light-panel{position:absolute;left:10px;right:10px;bottom:10px;z-index:4;' +
      'display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) auto;align-items:center;' +
      'gap:2px 14px;padding:8px 12px;background:rgba(16,21,28,.9);border:1px solid #2a323d;' +
      'border-radius:10px;box-shadow:0 14px 34px rgba(0,0,0,.5)}' +
    '.vs-light-panel[hidden]{display:none}' +
    '.vs-light-panel .vs-clear{margin:0;justify-self:end}' +
    '@media (max-width:620px){.vs-light-panel{grid-template-columns:1fr 1fr}}' +
    '.vs-slide{display:grid;grid-template-columns:1fr auto;align-items:center;gap:1px 8px}' +
    '.vs-slide label{color:#9aa4b2;font-size:.76rem}' +
    '.vs-slide output{color:#cdd6e0;font-size:.76rem;font-variant-numeric:tabular-nums}' +
    '.vs-slide input{grid-column:1/-1;width:100%;margin:2px 0 0;accent-color:var(--accent);cursor:pointer}' +
    '.vs-slide input:focus-visible{outline:2px solid var(--accent);outline-offset:3px}' +
    '@media (max-width:560px){.vs-tool span{position:absolute;width:1px;height:1px;' +
      'overflow:hidden;clip-path:inset(50%);white-space:nowrap}.vs-tool{padding:6px}}';
  var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
}

function load(key) {
  try { return JSON.parse(window.localStorage.getItem(key) || 'null'); }
  catch (e) { return null; }               // private mode, or someone else's key
}
function store(key, v) {                   // null clears it
  try {
    if (v) window.localStorage.setItem(key, JSON.stringify(v));
    else window.localStorage.removeItem(key);
  } catch (e) { /* not worth failing over */ }
}

function readBg() {
  var v = load(STORE_KEY);
  return (v && typeof v.mode === 'string') ? v : { mode: 'default', color: '#0c1118' };
}

function readLight() {
  var v = load(LIGHT_KEY), n = function (x) { return typeof x === 'number' && isFinite(x); };
  return (v && n(v.intensity) && n(v.azimuth) && n(v.elevation)) ? v : null;
}

function icon(d) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';
}
var ICON_IMAGE = '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
                 '<circle cx="8.5" cy="9.5" r="1.6"/><path d="M4 17l5-5 4 4 3-2 4 4"/>';
var ICON_SAVE = '<path d="M12 3v11"/><path d="M8 11l4 4 4-4"/><path d="M4 20h16"/>';
var ICON_LIGHT = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4' +
                 'M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';

var SLIDERS = [
  { k: 'intensity', label: 'Intensity', min: 0, max: 100, unit: '%' },
  { k: 'azimuth', label: 'Direction', min: 0, max: 360, unit: '°' },
  { k: 'elevation', label: 'Height', min: -90, max: 90, unit: '°' },
];

var GUIDE_SEGMENTS = 11;                 // 5 beams + 2 head barbs + 4 marker sides

function makeGuide(THREE) {
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(GUIDE_SEGMENTS * 6), 3));
  var lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    color: 0xff2f2f, transparent: true, opacity: 0.9,
    depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  lines.renderOrder = 999;
  lines.frustumCulled = false;            // the beams reach well outside the model
  return lines;
}

function aimGuide(THREE, lines, dir, center, radius, intensity) {
  var d = new THREE.Vector3().fromArray(dir).normalize();
  var up = Math.abs(d.y) > 0.98 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  var u = new THREE.Vector3().crossVectors(up, d).normalize();
  var v = new THREE.Vector3().crossVectors(d, u);
  var far = radius * 2.4, near = radius * 0.95;
  var off = radius * 0.42, head = radius * 0.16, mark = radius * 0.17;

  var p = lines.geometry.getAttribute('position').array, i = 0;
  var a = new THREE.Vector3(), b = new THREE.Vector3();
  function seg(from, to) {
    p[i++] = from.x; p[i++] = from.y; p[i++] = from.z;
    p[i++] = to.x; p[i++] = to.y; p[i++] = to.z;
  }
  function at(t, ou, ov) {
    return new THREE.Vector3().copy(center).addScaledVector(d, t)
      .addScaledVector(u, ou || 0).addScaledVector(v, ov || 0);
  }

  [[0, 0], [off, 0], [-off, 0], [0, off], [0, -off]].forEach(function (o) {
    seg(at(far, o[0], o[1]), at(near, o[0], o[1]));
  });
  a.copy(at(near));                                     // the head, pointing at the model
  seg(a, b.copy(a).addScaledVector(d, head).addScaledVector(u, head * 0.6));
  seg(a, b.copy(a).addScaledVector(d, head).addScaledVector(v, head * 0.6));
  var m = [at(far, mark, 0), at(far, 0, mark), at(far, -mark, 0), at(far, 0, -mark)];
  for (var k = 0; k < 4; k++) seg(m[k], m[(k + 1) % 4]);

  lines.geometry.getAttribute('position').needsUpdate = true;
  lines.geometry.computeBoundingSphere();
  lines.material.opacity = 0.3 + 0.65 * Math.max(0, Math.min(1, intensity));
}

function rasterGradient(ctx, w, h, a, b) {
  var cx = w * 0.5, cy = h * 0.4;
  var r = Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy),
                   Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy)) * 0.78;
  var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, a); g.addColorStop(1, b);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

function rasterCover(ctx, img, w, h) {
  var s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  var dw = img.naturalWidth * s, dh = img.naturalHeight * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function slug(name) {
  return String(name || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60) || 'model';
}

export function attach(opts) {
  injectStyles();
  var stage = opts.stage, canvas = opts.canvas, render = opts.render;
  var state = readBg();
  var lightable = true;

  var tools = document.createElement('div');
  tools.className = 'vs-tools';
  tools.innerHTML =
    (lightable ?
    '<button class="vs-tool vs-light-btn" type="button" aria-expanded="false">' +
      icon(ICON_LIGHT) + '<span>Lighting</span></button>' : '') +
    '<div class="vs-slot">' +
      '<button class="vs-tool vs-bg-btn" type="button" aria-expanded="false">' +
        icon(ICON_IMAGE) + '<span>Background</span></button>' +
      '<div class="vs-panel vs-bg-panel" hidden>' +
        '<span class="vs-legend">Backdrop</span>' +
        '<div class="vs-opts">' +
          '<button class="vs-opt" type="button" data-mode="default" aria-pressed="false">Default</button>' +
          '<button class="vs-opt" type="button" data-mode="none" aria-pressed="false">None</button>' +
          '<button class="vs-opt" type="button" data-mode="color" aria-pressed="false">Color</button>' +
          '<button class="vs-opt" type="button" data-mode="image" aria-pressed="false">Image</button>' +
        '</div>' +
        '<div class="vs-row vs-color-row" hidden>' +
          '<label for="" class="vs-color-label">Color</label>' +
          '<input type="color" class="vs-color">' +
        '</div>' +
        '<div class="vs-row vs-image-row" hidden>' +
          '<button class="vs-opt vs-pick" type="button">Choose file…</button>' +
          '<span class="vs-file"></span>' +
        '</div>' +
        '<input type="file" class="vs-input" accept="image/*" hidden>' +
      '</div>' +
    '</div>' +
    '<button class="vs-tool vs-save-btn" type="button">' +
      icon(ICON_SAVE) + '<span>Save PNG</span></button>';
  stage.appendChild(tools);

  var lightPanel = null;
  if (lightable) {
    lightPanel = document.createElement('div');
    lightPanel.className = 'vs-light-panel';
    lightPanel.hidden = true;
    lightPanel.innerHTML =
      SLIDERS.map(function (s, i) {
        return '<div class="vs-slide">' +
          '<label for="">' + s.label + '</label>' +
          '<output></output>' +
          '<input type="range" data-i="' + i + '" min="' + s.min + '" max="' + s.max + '" step="1">' +
        '</div>';
      }).join('') +
      '<button class="vs-clear vs-light-reset" type="button">Reset</button>';
    stage.appendChild(lightPanel);
  }

  var bgBtn = tools.querySelector('.vs-bg-btn'),
      saveBtn = tools.querySelector('.vs-save-btn'),
      panel = tools.querySelector('.vs-bg-panel'),
      colorRow = tools.querySelector('.vs-color-row'),
      colorIn = tools.querySelector('.vs-color'),
      colorLabel = tools.querySelector('.vs-color-label'),
      imageRow = tools.querySelector('.vs-image-row'),
      pickBtn = tools.querySelector('.vs-pick'),
      fileName = tools.querySelector('.vs-file'),
      fileIn = tools.querySelector('.vs-input');

  var lightBtn = tools.querySelector('.vs-light-btn');
  var pairs = [{ btn: bgBtn, el: panel }];
  if (lightPanel) pairs.push({ btn: lightBtn, el: lightPanel });

  var uid = String(++_uid);
  colorIn.id = 'vs-c-' + uid; colorLabel.setAttribute('for', colorIn.id);
  panel.id = 'vs-p-' + uid; bgBtn.setAttribute('aria-controls', panel.id);
  colorIn.value = state.color;
  if (lightPanel) {
    lightPanel.id = 'vs-l-' + uid;
    lightBtn.setAttribute('aria-controls', lightPanel.id);
    Array.prototype.forEach.call(lightPanel.querySelectorAll('input'), function (r, i) {
      r.id = 'vs-r' + i + '-' + uid;
      r.parentNode.querySelector('label').setAttribute('for', r.id);
    });
  }

  function apply() {
    var m = state.mode;
    if (m === 'default') stage.style.background = '';
    else if (m === 'color') stage.style.background = state.color;
    else if (m === 'image' && IMG.url) stage.style.background = 'center/cover no-repeat url("' + IMG.url + '")';
    else stage.style.background = 'none';

    Array.prototype.forEach.call(tools.querySelectorAll('.vs-opt[data-mode]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === m));
    });
    colorRow.hidden = m !== 'color';
    imageRow.hidden = m !== 'image';
    fileName.textContent = IMG.name || 'No file chosen';
  }

  function setMode(m) { state.mode = m; store(STORE_KEY, state); apply(); }

  function openPanel(p, on) {
    pairs.forEach(function (q) {
      var show = q.el === p && on;
      q.el.hidden = !show;
      q.btn.setAttribute('aria-expanded', String(show));
    });
    syncGuide();
  }
  function anyOpen() { return !panel.hidden || !!(lightPanel && !lightPanel.hidden); }
  function closeAll() { openPanel(null, false); }

  function onBgClick() { openPanel(panel, panel.hidden); }
  function onOptClick(e) {
    var b = e.target.closest ? e.target.closest('.vs-opt[data-mode]') : null;
    if (!b) return;
    var m = b.getAttribute('data-mode');
    setMode(m);
    if (m === 'image' && !IMG.el) fileIn.click();
  }
  function onColor() { state.color = colorIn.value; store(STORE_KEY, state); apply(); }
  function onPick() { fileIn.click(); }
  function onFile() {
    var f = fileIn.files && fileIn.files[0];
    if (!f) return;
    if (IMG.url) URL.revokeObjectURL(IMG.url);
    IMG.url = URL.createObjectURL(f);
    IMG.name = f.name;
    IMG.el = new Image();
    IMG.el.onload = function () { apply(); };
    IMG.el.onerror = function () { IMG.el = null; IMG.name = ''; setMode('default'); };
    IMG.el.src = IMG.url;
    fileIn.value = '';                       // so re-picking the same file still fires
    setMode('image');
  }
  function onKey(e) {
    if (e.key !== 'Escape' || !anyOpen()) return;
    e.stopPropagation();
    var open = panel.hidden ? lightBtn : bgBtn;
    closeAll(); open.focus();
  }
  function onDocDown(e) {
    if (!anyOpen()) return;
    if (tools.contains(e.target) || (lightPanel && lightPanel.contains(e.target))) return;
    closeAll();
  }

  var lightDefaults = lightable ? VM.lightControlDefaults() : null;
  var light = lightable ? readLight() : null;
  var ranges = lightPanel ? Array.prototype.slice.call(lightPanel.querySelectorAll('input')) : [];

  function lightValues() {
    return light || {
      intensity: Math.round(lightDefaults.intensity * 100),
      azimuth: lightDefaults.azimuth, elevation: lightDefaults.elevation,
    };
  }
  function showLight() {
    var v = lightValues();
    ranges.forEach(function (r) {
      var s = SLIDERS[+r.getAttribute('data-i')];
      r.value = v[s.k];
      r.parentNode.querySelector('output').textContent = v[s.k] + s.unit;
    });
  }
  function applyLight() {
    if (!light) return;
    VM.setLightControl({
      intensity: light.intensity / 100, azimuth: light.azimuth, elevation: light.elevation,
    });
    render();
  }
  function onRange(e) {
    var r = e.target, s = SLIDERS[+r.getAttribute('data-i')];
    if (!s) return;
    light = lightValues();
    light[s.k] = +r.value;
    store(LIGHT_KEY, light);
    showLight(); applyLight(); syncGuide();
  }
  function onLightReset() {
    light = null;
    store(LIGHT_KEY, null);
    VM.setLightControl(null);
    showLight(); syncGuide(); render();
  }

  var guide = null;
  function dropGuide() {
    if (!guide) return false;
    opts.scene.remove(guide);
    guide.geometry.dispose(); guide.material.dispose();
    guide = null;
    return true;
  }
  function syncGuide() {
    if (!lightPanel || !opts.scene || !opts.focus) return;
    if (lightPanel.hidden) { if (dropGuide()) render(); return; }
    var f = opts.focus();
    if (!guide) { guide = makeGuide(THREE); opts.scene.add(guide); }
    aimGuide(THREE, guide, VM.sunDirection(),
             f.center, f.radius || 1, lightValues().intensity / 100);
    render();
  }

  function snapshot() {
    var shown = guide && guide.visible;
    if (shown) guide.visible = false;
    render();
    var w = canvas.width, h = canvas.height;
    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var ctx = out.getContext('2d');
    var cs = window.getComputedStyle(stage);
    if (state.mode === 'default') {
      rasterGradient(ctx, w, h,
        (cs.getPropertyValue('--vs-bg-a') || '').trim() || GRAD_A,
        (cs.getPropertyValue('--vs-bg-b') || '').trim() || GRAD_B);
    } else if (state.mode === 'color') {
      ctx.fillStyle = state.color; ctx.fillRect(0, 0, w, h);
    } else if (state.mode === 'image' && IMG.el) {
      rasterCover(ctx, IMG.el, w, h);
    }
    ctx.drawImage(canvas, 0, 0, w, h);     // "none" leaves the PNG transparent behind the model
    if (shown) { guide.visible = true; render(); }
    save(out);
  }

  function save(out) {
    var name = slug(opts.name) + '.png';
    if (!out.toBlob) {                     // ancient browser: one big data: URL instead
      return download(out.toDataURL('image/png'), name, false);
    }
    out.toBlob(function (blob) {
      if (!blob) return;
      download(URL.createObjectURL(blob), name, true);
    }, 'image/png');
  }
  function download(href, name, revoke) {
    var a = document.createElement('a');
    a.href = href; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    if (revoke) setTimeout(function () { URL.revokeObjectURL(href); }, 1000);
  }

  bgBtn.addEventListener('click', onBgClick);
  saveBtn.addEventListener('click', snapshot);
  panel.addEventListener('click', onOptClick);
  colorIn.addEventListener('input', onColor);
  pickBtn.addEventListener('click', onPick);
  fileIn.addEventListener('change', onFile);
  tools.addEventListener('keydown', onKey);
  document.addEventListener('mousedown', onDocDown);
  if (lightPanel) {
    lightBtn.addEventListener('click', function () { openPanel(lightPanel, lightPanel.hidden); });
    lightPanel.addEventListener('input', onRange);
    lightPanel.addEventListener('keydown', onKey);
    lightPanel.querySelector('.vs-light-reset').addEventListener('click', onLightReset);
    showLight();
    applyLight();
  }

  apply();

  return {
    snapshot: snapshot,
    dispose: function () {
      document.removeEventListener('mousedown', onDocDown);
      if (lightPanel) { dropGuide(); lightPanel.remove(); }   // no redraw: the host is going away
      stage.style.background = '';
      if (tools.parentNode) tools.parentNode.removeChild(tools);
    },
  };
}

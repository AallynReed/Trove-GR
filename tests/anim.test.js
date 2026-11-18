import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { decode, sample, frameAt, timeline, programs, quatToMat } from '../src/viewer/anim-clips.js';
import { rigIndex } from '../scripts/rig-index.mjs';
import { readJson, readBytes } from './helpers.js';

const clip = (rig, name) => {
  const b = readBytes(`public/rigs/anim/${rig}/${name}.anim`);
  return decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

function findClip(stride) {
  for (const rig of readdirSync(new URL('../public/rigs/anim/', import.meta.url))) {
    for (const f of readdirSync(new URL(`../public/rigs/anim/${rig}/`, import.meta.url))) {
      const c = clip(rig, f.slice(0, -5));
      if (c.stride === stride) return [rig, f.slice(0, -5), c];
    }
  }
  return null;
}

test('both clip formats decode, and integer frames sample the stored floats', () => {
  for (const stride of [7, 12]) {
    const [rig, name, c] = findClip(stride);
    const meta = readJson(`public/rigs/${rig}.rig.json`).animations[name];
    assert.equal(c.frameCount, meta.frames, name);
    assert.equal(c.fps, meta.fps, name);
    assert.equal(c.data.length, c.frameCount * c.apCount * stride);
    const ap = Object.keys(c.apIndex)[0], ai = c.apIndex[ap];
    for (const f of [0, c.frameCount - 1]) {
      const pose = sample({ A: c, f, B: null, g: 0, u: 0 }, ap);
      const o = (f * c.apCount + ai) * stride;
      assert.deepEqual(pose.p, Array.from(c.data.slice(o, o + 3)));
      if (stride === 7) assert.deepEqual(pose.q, Array.from(c.data.slice(o + 3, o + 7)));
      else assert.deepEqual(pose.m, Array.from(c.data.slice(o + 3, o + 12)));
    }
  }
});

test('quaternions in rigid clips are unit length', () => {
  const [, , c] = findClip(7);
  const m = new Array(9);
  for (let i = 0; i < c.frameCount * c.apCount; i++) {
    const q = Array.from(c.data.slice(i * 7 + 3, i * 7 + 7));
    assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-4);
    quatToMat(q, m);
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[3] * (m[1] * m[8] - m[2] * m[7]) + m[6] * (m[1] * m[5] - m[2] * m[4]);
    assert.ok(Math.abs(det - 1) < 1e-3);
  }
});

test('a move plays its clips in order on one timeline', () => {
  const rig = readJson('public/rigs/adventurer.rig.json');
  const kit = programs(rig.animations, readJson('public/rigs/graph/adventurer.graph.json'));
  const key = 'move:unarmed_jump_begin+unarmed_jump_cycle+unarmed_jump_end';
  assert.ok(kit.programs[key]);
  const loaded = {};
  for (const n of kit.programs[key].clips) loaded[n] = clip('adventurer', n);
  const prog = timeline(kit.programs[key], loaded);
  const names = kit.programs[key].clips;
  names.forEach((n, i) => assert.equal(frameAt(prog, prog.starts[i] + prog.blends[i] + 0.01).A, loaded[n], n));
  const fade = frameAt(prog, prog.starts[1] + prog.blends[1] / 2);
  assert.equal(fade.A, loaded[names[0]]);
  assert.equal(fade.B, loaded[names[1]]);
  assert.ok(prog.total > 0);
});

test('every rig in the index ships its clips and matches the index', () => {
  const idx = readJson('public/rigs/index.json');
  assert.deepEqual(idx, rigIndex('public/rigs'));
  for (const { name } of idx.rigs) {
    for (const a of Object.keys(readJson(`public/rigs/${name}.rig.json`).animations || {})) {
      assert.ok(existsSync(new URL(`../public/rigs/anim/${name}/${a}.anim`, import.meta.url)), `${name}/${a}`);
    }
  }
});

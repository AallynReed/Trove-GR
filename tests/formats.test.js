import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, constants } from 'node:zlib';
import { inflate } from '../src/formats/inflate.js';
import { decodeCells, grid, version, isEmpty, inflateV5 } from '../src/formats/blueprint.js';
import { readTmod, calculateHash } from '../src/formats/tmod.js';
import { readJson, b64 } from './helpers.js';

function noise(n, seed) {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; out[i] = (s >>> 16) % (i % 7 ? 9 : 256); }
  return out;
}

test('inflate matches zlib at every level', () => {
  for (const level of [0, 1, 6, 9]) {
    const data = noise(70000, level + 1);
    const z = inflate(deflateSync(data, { level }));
    assert.equal(z.eof, true);
    assert.deepEqual(z.data, data);
  }
});

test('inflate keeps what decoded from a cut stream and rejects corruption', () => {
  const data = noise(5000, 7);
  const full = deflateSync(data, { level: 0 });
  const cut = inflate(full.subarray(0, 3000));
  assert.equal(cut.eof, false);
  assert.deepEqual(cut.data, data.subarray(0, cut.data.length));
  assert.ok(cut.data.length > 2000);
  const bad = Uint8Array.from(deflateSync(data));
  bad[bad.length - 1] ^= 0xff;
  assert.equal(inflate(bad), null);
  assert.equal(inflate(new Uint8Array([0x12, 0x34, 1, 2])), null);
  const trailing = new Uint8Array([...deflateSync(data), 1, 2, 3]);
  assert.deepEqual(inflate(trailing).data, data);
});

test('blueprint grids match the reference decoder', () => {
  const fx = readJson('tests/fixtures/assembly.json');
  for (const [name, blob] of Object.entries(fx.blobs)) {
    const raw = b64(blob), want = fx.grids[name], v = version(raw);
    assert.equal(v, want.version, name);
    assert.equal(isEmpty(raw), want.empty, name);
    const cells = grid(v, v === 5 ? inflateV5(raw) : raw);
    assert.deepEqual(cells.map((c) => [c.x, c.y, c.z, c.r, c.g, c.b, c.kind, c.level, c.spec]), want.cells, name);
  }
});

test('blueprint decoding refuses what is not a part', () => {
  assert.equal(decodeCells(new Uint8Array([1, 2, 3])), null);
  assert.equal(decodeCells(b64(readJson('tests/fixtures/reference.json').blobs.blank)), null);
  const truncated = new Uint8Array([...Buffer.from('kiwib'), 3, 0, 0, 0, 5, 0x80]);
  assert.throws(() => decodeCells(truncated), /grid decode failed/);
});

test('calculateHash matches the game checksum', () => {
  assert.equal(calculateHash(new Uint8Array()), 2166136261);
  // tail bytes are sign-extended, so 0xff differs from 0x7f
  assert.notEqual(calculateHash(new Uint8Array([0xff])), calculateHash(new Uint8Array([0x7f])));
  assert.equal(calculateHash(new Uint8Array([1, 2, 3, 4])), Math.imul(16777619, (2166136261 ^ 0x04030201) >>> 0) >>> 0);
});

function buildTmod(files, { sync }) {
  const leb = (v, o) => { do { let b = v & 127; v >>>= 7; if (v) b |= 128; o.push(b); } while (v); };
  const stream = [], table = [];
  for (const [path, data] of files) {
    table.push(path.length, ...Buffer.from(path));
    leb(0, table); leb(data.length ? stream.length : 0, table); leb(data.length, table); leb(calculateHash(data), table);
    stream.push(...data);
    while (stream.length % 4) stream.push(0);
  }
  const head = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0];
  const prop = [];
  leb(5, prop); prop.push(...Buffer.from('title')); leb(4, prop); prop.push(...Buffer.from('test'));
  const header = [...head, ...prop, ...table];
  const size = header.length;
  for (let i = 0; i < 8; i++) header[i] = i < 4 ? (size >>> (8 * i)) & 255 : 0;
  const body = deflateSync(Uint8Array.from(stream), { level: 0, finishFlush: sync ? constants.Z_SYNC_FLUSH : constants.Z_FINISH });
  return new Uint8Array([...header, ...body]);
}

test('tmod files come back intact from a finished or a sync-flushed stream', () => {
  const files = [['blueprints/a.blueprint', noise(40000, 3)], ['empty.txt', new Uint8Array()], ['blueprints/b.blueprint', noise(33, 4)]];
  for (const sync of [false, true]) {
    const t = readTmod(buildTmod(files, { sync }));
    assert.deepEqual(t.properties, [['title', 'test']]);
    assert.deepEqual(t.files.map((f) => f.path), files.map((f) => f[0]));
    t.files.forEach((f, i) => assert.deepEqual(f.data, files[i][1]));
  }
  assert.throws(() => readTmod(new Uint8Array(4)), /too small/);
});

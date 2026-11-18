# Architecture

Trove-GR turns blueprint files into a posed, animated creature in four stages. Everything outside `src/app/`, `src/viewer/` and `src/render/` is plain ES modules that also run in Node, which is how the tests check them against the reference server's output.

```
.blueprint / .tmod ──decode──▶ voxel cells ──resolve──▶ parts on attach points ──assemble──▶ model payload ──view──▶ WebGL
     formats/blueprint, tmod          rig/bindings              rig/rig                      viewer/model-viewer
```

## Source layout

| Path | Role |
| --- | --- |
| `src/formats/inflate.js` | zlib inflate with zlib's semantics: corrupt data fails, a stream cut short keeps what decoded, trailing bytes are ignored. Trove's `.tmod` streams end without a final block, so the platform's `DecompressionStream`, which throws on that, isn't used. |
| `src/formats/blueprint.js` | `.blueprint` v3/v4 (varint records) and v5 (zlib tables). Assembly uses the grid-preserving decode: absolute grid coordinates, the v5 origin kept, no mirroring, every voxel kept, materials from the voxel type. |
| `src/formats/tmod.js` | `.tmod` header table, zlib or stored-block de-framing chosen by the game's checksum on the first four files. |
| `src/rig/bindings.js` | The prefab binding map: variant matching (`[style]`, `_lvlN`), majority-vote skeleton, per-part attach points, head and mesh scales, prefab lookup, nearest game path. |
| `src/rig/rig.js` | A rig (rest matrices, head attach points) and the assembly: part decode, same-point merge, the enclosed-glow nudge, the payload. |
| `src/rig/exact.js` | Correctly rounded fused multiply-add, half-even rounding and numpy's pairwise sum, so the nudge lands on exactly the reference's floats. |
| `src/rig/session.js` | What the app places: a dropped set, a game prefab, or attach-point markers, each with a per-part report. |
| `src/viewer/anim-clips.js` | Clip decoding (`TANIM1`/`TANIM2`), clip grouping, moves built from the rig's state machine, the clip bar, timelines with cross-fades, and pose sampling. |
| `src/viewer/model-viewer.js` | Builds meshes per part, places them on rest or sampled attach-point matrices, orbit/pan/zoom, and the `state()`/`poseFrame()` hooks. |
| `src/viewer/viewer-stage.js` | Backdrop, sun control with guide rays, PNG snapshot. |
| `src/render/voxel-mesh.js` | Visible-face meshing per material group and Trove's object shader (wrap diffuse, specular atlas lobe, ambient, glow, glass). |
| `src/io/sources.js` | File pickers, drops, and the two rig sources: the built-in set and a user-picked folder. |
| `src/app/` | The application shell: rig and creature lists, inspector, drop handling. |
| `tools/granny/` | The offline decoder that produced `public/rigs` from the game's Granny files. |

## Placement is authoritative

Every part's skeleton and attach point comes from the game's prefab bindings. There are no fallbacks on part names: if the bindings don't place a part, the report says why and the part is not drawn. The binding rows are sorted by prefab, then blueprint, in byte order, as the reference server loads them, because the first row for a blueprint decides its skeleton and owner.

## Numerical parity

The reference assembly was written in numpy and later ported to Rust with the same rounding. The JavaScript port keeps it bit for bit: world positions use the fused multiply-add chain BLAS uses, the outward direction uses numpy's pairwise mean, and the 3x3 inverse follows LAPACK's LU order. `tests/fixtures/reference.json` holds the server's golden cases (946 nudges across every rig), and `tests/fixtures/assembly.json` holds synthetic parts with the Rust assembly's output.

## Test hooks

The app exposes `window.TroveGR` with `state()`, `poseFrame(clip, frame)`, `play(key)`, `view()`, `showRig(name)` and `showPrefab(path)`. Playback runs on `requestAnimationFrame`, which doesn't fire in a hidden tab, so `poseFrame` poses one frame directly and returns each part's matrix.

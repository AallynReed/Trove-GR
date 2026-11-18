# trove-gr

`trove-gr` turns Trove's Granny files into the rig JSONs, animation graphs and `.anim` clips the viewer loads. It reads a Trove install directly (the `.tfi` indexes and `.tfa` archives), so nothing has to be extracted first. The outputs in the viewer's `public/rigs/` were made this way; this folder is how to rebuild them after a game update.

## Requirements

- Windows, because the tool calls into the Granny DLL.
- Rust stable, to build it.
- Your own Granny 2.11 or later `granny2_x64.dll`, one that exports the incremental BitKnit API (`GrannyBeginFileDecompression`, `GrannyDecompressIncremental`, `GrannyEndFileDecompression`). It belongs to the proprietary RAD/Epic Granny SDK, so it is never bundled or committed, and neither is `granny.h`, the libs or the SDK zip. `.gitignore` excludes them.

The DLL is found in this order: `--granny <path>`, then the `GRANNY_DLL` environment variable, then `granny2_x64.dll` next to `trove-gr.exe`.

## Build

```powershell
cd tools\granny
cargo build --release
```

The exe is `target\release\trove-gr.exe`. `.cargo\config.toml` links the C runtime statically, so the exe runs on a machine without the Visual C++ redistributable. Pushing a `v*` tag runs `.github/workflows/granny-release.yml`, which builds the exe on Windows and attaches it to a GitHub Release.

## Usage

The whole pipeline in one command:

```powershell
.\trove-gr.exe --trove "<Trove install>\Live" --granny <sdk>\granny2_x64.dll --out <out>\rigs
```

`--from-dir <tree>` reads an already-extracted tree that holds `models\` and `prefabs\` instead of the install. `--jobs N` sets the number of bake processes (default: one per core). `--keep-work` keeps the intermediate files in `<out>\_work`.

The output folder has the layout the viewer loads: `<out>\<rig>.rig.json`, `<out>\graph\<rig>.graph.json`, `<out>\anim\<rig>\<clip>.anim`, plus `<out>\index.json` (`{"rigs": [{"name", "aps", "clips"}]}`, where `aps` counts the rest keys and `clips` the animations).

An existing output folder is updated in place: rest rigs that already exist are left alone, and the assets step merges into them. Point `--out` at a copy of the shipped `public\rigs` to reproduce a re-export, including the reduced-skeleton rule below.

### Single stages

Each stage is also a subcommand working on extracted folders. They run in this order, because the graph, bake and assets stages only process stems that already have a `<stem>.rig.json`.

```powershell
.\trove-gr.exe skeletons --models <game>\models --out .\skeletons
.\trove-gr.exe rigs --skeletons .\skeletons --rigs .\rigs
.\trove-gr.exe graph --models <game>\models --prefabs <game>\prefabs --out .\rigs\graph --clips .\rig_clips.json
.\trove-gr.exe bake --models <game>\models --rigs .\rigs --clips .\rig_clips.json --cache .\posecache
.\trove-gr.exe assets --cache .\posecache --rigs .\rigs
.\trove-gr.exe index --rigs .\rigs
```

- `rigs` skips existing rig files unless you pass `--force`, and always skips `companion_spidermonkey`, whose shipped rig predates this pipeline. The full pipeline does not skip it.
- `graph` and `assets` take `--only <substring>` and `--dry`. `bake` takes `--only`, `--limit N`, `--no-resume` and `--jobs N`; by default it resumes and skips clips already in the cache.
- `.\trove-gr.exe decompress <file.gr2> <dir>` writes every section of a GR2, decompressed, to `<dir>\secN.bin`.
- `.\trove-gr.exe skeleton <file.gr2> <out.json>` writes one skeleton, including flags and inverse world matrices.

## Rules the code applies

- **Which `.gsf` a rig plays.** A rig uses its own `<rig>.gsf` when one exists. Otherwise it uses the single `.gsf` that the prefabs pair with its `<rig>.skeleton.gr2`: a prefab names the skeleton, and the next `.gsf` string after it is the pair. If the prefabs name more than one `.gsf`, the rig gets none. A rig whose state machine has no edges gets no graph file, but it still appears in `rig_clips.json`.
- **Clip set.** A rig's clips are its own `<stem>@*.gr2` files plus the `@` clips its `.gsf` references (from `rig_clips.json`). When two share a name, the `.gsf` clip wins. File names match case-insensitively. Every clip is sampled at 30 fps, from frame 0 to `round(Duration * 30)` inclusive, with ties rounded to even.
- **Held tails trimmed.** Trailing frames are dropped while the last two frames differ by less than 1e-3 (in position and in the quaternion, or the 3x3 for non-rigid clips). A clip is never trimmed below 4 frames.
- **Wrap frame dropped.** If a clip with 3 or more frames ends on a frame within 1e-3 of frame 0, that last frame is dropped. The viewer interpolates back to frame 0 on its own.
- **Motionless clips dropped.** After trimming, a clip in which nothing moves 1e-3 or more from frame 0 is not written. The summary prints how many were dropped.
- **Rest pose.** `rest` is frame 0 of a surviving clip, chosen in this order: `unarmed_idle`, then `idle`, then the first name in sort order that contains `idle` and does not start with `mount`, then the first non-mount clip, then the first clip of any kind. The choice is recorded in `rest_from`. A rig with no surviving clips keeps the skeleton's bind pose and has no `rest_from`. The bind pose is avoided because it is an authoring T-pose, not a pose the game shows.
- **Attach points.** These are the `AP_*` bones, keyed by their lowercase name without the `ap_` prefix. `prop_r_JNT` and `prop_l_JNT` are added under their lowercase names, because they are the weapon sockets.
- **Reduced skeletons.** If the new attach-point set is a strict subset of the `ap_keys` already in a rig file, the assets stage skips that rig and prints a warning. Some creatures ship a reduced `<stem>.gr2` next to a full `<stem>.skeleton.gr2`.
- **Stale files.** For every rig it rebuilds, the assets stage deletes that rig's `.anim` files that are no longer produced (with `--only` too, but not with `--dry`). The graph stage deletes graph files that are no longer produced, only on a run without `--only`.
- **Voxel scale.** `voxel_scale` is fixed at 1/12. This was measured: 96.4% of the mesh bounding boxes in the `.gr2` files are a whole number of 1/12 units (the rest are skinned meshes, which are not boxes), and the sizes match the game's own `.blueprint` files.

## Formats

### Trove archives

Each folder of the install holds an `index.tfi` and `archiveN.tfa` files. The index is a run of records: a uleb128 name length, the name (NUL-terminated, backslashes read as `/`), then uleb128 archive number, offset, size and checksum. Each `.tfa` is one zlib stream without a final block; a file is `inflated[offset .. offset + size]`. The checksum is Trove's FNV-1a variant over little-endian 4-byte words, with the 1 to 3 tail bytes read as signed chars, and it is checked for every file.

### GR2 sections

The section count is a u32 at offset 48. The section table begins at `32 + u32@44`, and each 44-byte entry is the `granny_grn_section` of `granny.h` (compression, data offset, packed size, unpacked size, alignment, first 16-bit, first 8-bit, fixup offsets). Compression 0 is stored, 2 is Oodle1 (whole-buffer call with the 16/8-bit stops) and 4 is BitKnit (incremental API, 0x2000-byte chunks, 0x4000-byte work buffer).

### Pose cache (`TPOSE1`)

One file per clip, `<cache>\<stem>\<clip>.pose`, and one `_bones.json` per stem with `skeleton`, `names`, `parents` and `rest_local` (`[{pos, quat, ss}]`). All values are little-endian.

| field | type |
|---|---|
| magic | 8 bytes, `TPOSE1\0\0` |
| bone_count, frame_count, fps | u32 each |
| has_scaleshear | u8, then 3 bytes of padding (24-byte header) |
| data | f32 `[frame][bone][7 or 16]`: pos xyz, quat xyzw, then a row-major 3x3 scale/shear when has_scaleshear is 1 |

has_scaleshear is set when any bone's scale/shear differs from identity by more than 1e-6 in any frame.

### Clips (`TANIM1` / `TANIM2`)

`anim\<rig>\<clip>.anim`, little-endian: an 8-byte magic, then u32 `ap_count`, `frame_count`, `fps` and `name_blob_len`, then the AP keys separated by NUL and padded with NUL to a multiple of 4 bytes, then `frames x aps` records of f32. The padding keeps the floats aligned, so the viewer can wrap them in a `Float32Array` without copying.

- `TANIM1\0\0`: 7 floats per record, world position xyz and quaternion xyzw (w kept at 0 or above).
- `TANIM2\0\0`: 12 floats per record, position xyz then the column-major 3x3 linear part. Used only for clips in which some attach point is not rigid, meaning `M * M^T` differs from the identity by 1e-3 or more somewhere (a folded wing drawn at reduced scale, for example).

### Rig JSON (`<rig>.rig.json`)

- `voxel_scale`: 1/12.
- `ap_keys`: the sorted attach-point keys.
- `rest`: `{ap: [16 floats]}`, a column-major 4x4 world matrix per attach point.
- `bones`: `{names, parents, rest_local}`. `rest_local` holds each bone's bind-pose `[pos xyz, quat xyzw]`, rounded to 6 decimal places; scale/shear is not stored.
- `animations`: `{clip: {fps, frames}}`, counted after trimming.
- `rest_from`: the clip whose frame 0 provides `rest`.

The `rigs` stage writes only `voxel_scale`, `ap_keys`, bind-pose `rest` and an empty `animations`. The assets stage replaces those keys and leaves any other keys in the file alone. JSON is written the way Python's `json.dump` writes it (same float repr, `\uXXXX` escapes and separators), so files diff cleanly against earlier exports.

### Graph JSON (`graph\<rig>.graph.json`)

- `rig`, and `source`, the state machine's file (`models/<gsf>.gsf`).
- `slots`: `{slot index: clip name}`.
- `sources`: `{clip name: source .gr2 basename}`.
- `nodes`: `{id: {name, kind, parent?, clip?, slot?, speed?, loop?, clips?}}`. `clips` lists every clip at or below a container node.
- `edges`: `[{from, to, when, blend, name?, probability?, conditions?: [{kind, name}], invert?, requiresAll?, fromAnyState?}]`.

`when` is the transition's type as the file stores it: `onloop` (the clip ended), `lastresort` (a later-pass fallback when the clip ended), `onrequest` (gameplay asked for the state), `onsubloop` (a child node finished), `onconditional` (its conditions hold) or `dynamic` (chosen by game code). `blend` is the cross-fade length in seconds.

## Notes on the Granny binding

- `granny.h` wraps every struct in `#pragma pack(4)`, so on x64 an 8-byte pointer can sit at a 4-byte offset. Every struct in `src/granny.rs` is `#[repr(C, packed(4))]`, and compile-time asserts pin their sizes. Without the packing, `granny_file_info` reads plausible garbage instead of failing.
- `DataTypeDef.ignored` is pointer-sized (`granny_uintaddrx`). The graph walker steps through type definitions as an array, so a wrong size throws the whole walk out of step.
- `Animation.duration` is the field right after `name`. Reading `oversampling` by mistake gives 2.0 for every clip.
- `GrannyDecompressIncremental`, `GrannyEndFileDecompression` and `GrannyDecompressData` return a one-byte C++ `bool`, so they are declared as returning `u8`.
- Granny is not safe to sample from two threads at once: a two-thread bake crashes inside the DLL. A parallel bake therefore runs one worker process per job (the hidden `bake-worker` subcommand), each with its own model instance, and a worker that dies is restarted once.
- The graph walk recurses deeply, so it runs on a thread with a 1 GB stack.

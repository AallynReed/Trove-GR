//! TPOSE1 pose cache -> <rigs>/<stem>.rig.json (updated in place) + <rigs>/anim/<stem>/<clip>.anim (TANIM1/TANIM2).

use crate::pyjson::{self, Style, round6};
use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const MAGIC: &[u8; 8] = b"TANIM1\0\0";
const MAGIC2: &[u8; 8] = b"TANIM2\0\0";
const EPS_TRIM: f64 = 1e-3;
const RIGID_EPS: f64 = 1e-3;
pub const VOXEL_SCALE: f64 = 1.0 / 12.0;
const EXTRA_SOCKET_BONES: [&str; 2] = ["prop_r_JNT", "prop_l_JNT"];

type M3 = [[f64; 3]; 3];
type M4 = [[f64; 4]; 4];

pub struct Opts<'a> {
    pub cache: &'a Path,
    pub rigs: &'a Path,
    pub only: Option<&'a str>,
    pub dry: bool,
}

struct Pose {
    bc: usize,
    fc: usize,
    fps: u32,
    has_ss: bool,
    data: Vec<f32>,
}

fn read_pose(path: &Path) -> Result<Pose> {
    let raw = std::fs::read(path)?;
    if raw.len() < 24 || &raw[..8] != crate::bake::MAGIC {
        bail!("bad pose magic in {}", path.display());
    }
    let u = |o: usize| u32::from_le_bytes(raw[o..o + 4].try_into().expect("4 bytes"));
    let (bc, fc, fps, has_ss) = (u(8) as usize, u(12) as usize, u(16), raw[20] != 0);
    let per = if has_ss { 16 } else { 7 };
    let n = fc * bc * per;
    if raw.len() < 24 + n * 4 {
        bail!("buffer is smaller than requested size in {}", path.display());
    }
    let data = raw[24..24 + n * 4].chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().expect("4"))).collect();
    Ok(Pose { bc, fc, fps, has_ss, data })
}

fn quat_to_mat3(q: [f64; 4]) -> M3 {
    let s = q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
    let n = (q[0] * q[0] + s).sqrt();
    let n = if n == 0.0 { 1.0 } else { n };
    let (x, y, z, w) = (q[0] / n, q[1] / n, q[2] / n, q[3] / n);
    [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
    ]
}

fn mat3_to_quat(m: &M3) -> [f64; 4] {
    let t = m[0][0] + m[1][1] + m[2][2];
    let mut q = [0.0; 4];
    if t > 0.0 {
        let s = (t + 1.0).max(1e-20).sqrt() * 2.0;
        q[3] = 0.25 * s;
        q[0] = (m[2][1] - m[1][2]) / s;
        q[1] = (m[0][2] - m[2][0]) / s;
        q[2] = (m[1][0] - m[0][1]) / s;
    } else if m[0][0] >= m[1][1] && m[0][0] >= m[2][2] {
        let s = (1.0 + m[0][0] - m[1][1] - m[2][2]).max(1e-20).sqrt() * 2.0;
        q[3] = (m[2][1] - m[1][2]) / s;
        q[0] = 0.25 * s;
        q[1] = (m[0][1] + m[1][0]) / s;
        q[2] = (m[0][2] + m[2][0]) / s;
    } else if m[1][1] >= m[2][2] {
        let s = (1.0 + m[1][1] - m[0][0] - m[2][2]).max(1e-20).sqrt() * 2.0;
        q[3] = (m[0][2] - m[2][0]) / s;
        q[0] = (m[0][1] + m[1][0]) / s;
        q[1] = 0.25 * s;
        q[2] = (m[1][2] + m[2][1]) / s;
    } else {
        let s = (1.0 + m[2][2] - m[0][0] - m[1][1]).max(1e-20).sqrt() * 2.0;
        q[3] = (m[1][0] - m[0][1]) / s;
        q[0] = (m[0][2] + m[2][0]) / s;
        q[1] = (m[1][2] + m[2][1]) / s;
        q[2] = 0.25 * s;
    }
    if q[3] < 0.0 {
        q = q.map(|v| -v);
    }
    q
}

fn mul3(a: &M3, b: &M3) -> M3 {
    let mut c = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            c[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    c
}

fn mul4(a: &M4, b: &M4) -> M4 {
    let mut c = [[0.0; 4]; 4];
    for i in 0..4 {
        for j in 0..4 {
            c[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j] + a[i][3] * b[3][j];
        }
    }
    c
}

fn trs(pos: [f64; 3], r: &M3) -> M4 {
    let mut m = [[0.0; 4]; 4];
    for i in 0..3 {
        m[i][..3].copy_from_slice(&r[i]);
        m[i][3] = pos[i];
    }
    m[3][3] = 1.0;
    m
}

fn compose_world(locals: &[M4], parents: &[i64]) -> Vec<M4> {
    let mut world: Vec<M4> = Vec::with_capacity(locals.len());
    for (i, &p) in parents.iter().enumerate() {
        let w = if p < 0 { locals[i] } else { mul4(&world[p as usize], &locals[i]) };
        world.push(w);
    }
    world
}

fn col_major(m: &M4) -> Vec<f64> {
    (0..4).flat_map(|c| (0..4).map(move |r| m[r][c])).collect()
}

fn is_rigid<'a>(mats: impl IntoIterator<Item = &'a M3>) -> bool {
    let mut worst: f64 = 0.0;
    for m in mats {
        for i in 0..3 {
            for j in 0..3 {
                let d = m[i][0] * m[j][0] + m[i][1] * m[j][1] + m[i][2] * m[j][2] - if i == j { 1.0 } else { 0.0 };
                worst = worst.max(d.abs());
            }
        }
    }
    worst < RIGID_EPS
}

fn maxdiff(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).fold(0.0f64, |m, (x, y)| m.max((x - y).abs()))
}

/// Frame-major (frame, ap, k) series.
struct Series {
    k: usize,
    v: Vec<f64>,
}

impl Series {
    fn frame(&self, f: usize, aps: usize) -> &[f64] {
        &self.v[f * aps * self.k..(f + 1) * aps * self.k]
    }
}

fn trim_held(pos: &Series, rot: &Series, aps: usize, n: usize) -> usize {
    let mut end = n;
    while end > 4 {
        let dp = maxdiff(pos.frame(end - 1, aps), pos.frame(end - 2, aps));
        let dq = maxdiff(rot.frame(end - 1, aps), rot.frame(end - 2, aps));
        if dp.max(dq) >= EPS_TRIM {
            break;
        }
        end -= 1;
    }
    end
}

fn drop_wrap_frame(pos: &Series, rot: &Series, aps: usize, n: usize) -> usize {
    if n < 3 {
        return n;
    }
    let dp = maxdiff(pos.frame(n - 1, aps), pos.frame(0, aps));
    let dq = maxdiff(rot.frame(n - 1, aps), rot.frame(0, aps));
    if dp.max(dq) < EPS_TRIM { n - 1 } else { n }
}

fn has_motion(pos: &Series, rot: &Series, aps: usize, n: usize) -> bool {
    if n < 2 {
        return false;
    }
    let mut d: f64 = 0.0;
    for f in 0..n {
        d = d.max(maxdiff(pos.frame(f, aps), pos.frame(0, aps)));
        d = d.max(maxdiff(rot.frame(f, aps), rot.frame(0, aps)));
    }
    d >= EPS_TRIM
}

fn rest_clip(names: &[String]) -> Option<String> {
    for want in ["unarmed_idle", "idle"] {
        if names.iter().any(|n| n == want) {
            return Some(want.to_string());
        }
    }
    let mut sorted: Vec<&String> = names.iter().collect();
    sorted.sort();
    if let Some(n) = sorted.iter().find(|n| n.contains("idle") && !n.starts_with("mount")) {
        return Some((*n).clone());
    }
    if let Some(n) = sorted.iter().find(|n| !n.starts_with("mount")) {
        return Some((*n).clone());
    }
    sorted.first().map(|n| (*n).clone())
}

fn key_blob(ap_keys: &[String]) -> Vec<u8> {
    let mut blob: Vec<u8> = Vec::new();
    for (i, k) in ap_keys.iter().enumerate() {
        if i > 0 {
            blob.push(0);
        }
        blob.extend(k.chars().map(|c| if c.is_ascii() { c as u8 } else { b'?' }));
    }
    while blob.len() % 4 != 0 {
        blob.push(0);
    }
    blob
}

fn write_anim(path: &Path, magic: &[u8; 8], ap_keys: &[String], fps: u32, frames: usize, rec: &[f64]) -> Result<usize> {
    let blob = key_blob(ap_keys);
    let mut buf = Vec::with_capacity(24 + blob.len() + rec.len() * 4);
    buf.extend_from_slice(magic);
    for v in [ap_keys.len() as u32, frames as u32, fps, blob.len() as u32] {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    buf.extend_from_slice(&blob);
    for &v in rec {
        buf.extend_from_slice(&(v as f32).to_le_bytes());
    }
    std::fs::write(path, &buf)?;
    Ok(buf.len())
}

struct Built {
    ap_keys: Vec<String>,
    rest: Map<String, Value>,
    meta: Map<String, Value>,
    total: usize,
    bones: Value,
    rest_from: Option<String>,
    statics: usize,
}

fn floats_of(v: &Value) -> Vec<f64> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_f64).collect()).unwrap_or_default()
}

fn build(stem: &str, o: &Opts) -> Result<Option<Built>> {
    let d = o.cache.join(stem);
    let bones: Value = serde_json::from_slice(&std::fs::read(d.join("_bones.json"))?)?;
    let names: Vec<String> =
        bones["names"].as_array().context("names")?.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect();
    let parents: Vec<i64> = bones["parents"].as_array().context("parents")?.iter().filter_map(Value::as_i64).collect();
    let mut ap_idx: BTreeMap<String, usize> = BTreeMap::new();
    for (i, n) in names.iter().enumerate() {
        let l = n.to_lowercase();
        if l.starts_with("ap_") {
            ap_idx.insert(n.chars().skip(3).collect::<String>().to_lowercase(), i);
        }
    }
    let extra: BTreeSet<String> = EXTRA_SOCKET_BONES.iter().map(|b| b.to_lowercase()).collect();
    for (i, n) in names.iter().enumerate() {
        let l = n.to_lowercase();
        if extra.contains(&l) {
            ap_idx.entry(l).or_insert(i);
        }
    }
    if ap_idx.is_empty() {
        return Ok(None);
    }
    let ap_keys: Vec<String> = ap_idx.keys().cloned().collect();
    let idx: Vec<usize> = ap_keys.iter().map(|k| ap_idx[k]).collect();
    let aps = idx.len();

    let rigpath = o.rigs.join(format!("{stem}.rig.json"));
    if rigpath.exists() {
        let shipped: BTreeSet<String> = std::fs::read(&rigpath)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.get("ap_keys").and_then(Value::as_array).cloned())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        let mine: BTreeSet<String> = ap_keys.iter().cloned().collect();
        if !shipped.is_empty() && mine.is_subset(&shipped) && mine.len() < shipped.len() {
            println!(
                "SKIP {stem:<38} this extract's model has {} attach points, the shipped rig has {} - keeping the shipped one",
                ap_keys.len(),
                shipped.len()
            );
            return Ok(None);
        }
    }

    let rest_local = bones["rest_local"].as_array().context("rest_local")?;
    let bind: Vec<M4> = rest_local
        .iter()
        .map(|b| {
            let p = floats_of(&b["pos"]);
            let q = floats_of(&b["quat"]);
            let ss = b["ss"].as_array().map(|r| r.iter().map(floats_of).collect::<Vec<_>>()).unwrap_or_default();
            let ssm: M3 = std::array::from_fn(|i| std::array::from_fn(|j| ss[i][j]));
            let r = mul3(&quat_to_mat3([q[0], q[1], q[2], q[3]]), &ssm);
            trs([p[0], p[1], p[2]], &r)
        })
        .collect();
    let rw = compose_world(&bind, &parents);
    let mut rest = Map::new();
    for (k, &i) in ap_keys.iter().zip(&idx) {
        rest.insert(k.clone(), pyjson::floats(col_major(&rw[i])));
    }

    let mut meta = Map::new();
    let (mut total, mut statics) = (0usize, 0usize);
    let mut frame0: Vec<(String, Vec<[f64; 3]>, Vec<[f64; 4]>, Vec<M3>)> = Vec::new();
    let outdir = o.rigs.join("anim").join(stem);
    if !o.dry {
        std::fs::create_dir_all(&outdir)?;
    }
    let mut poses: Vec<String> = std::fs::read_dir(&d)?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".pose"))
        .collect();
    poses.sort();
    for pf in poses {
        let aname = pf[..pf.len() - 5].to_string();
        let p = read_pose(&d.join(&pf))?;
        if p.bc != names.len() {
            bail!("{stem}/{aname} bone-count drift {} != {}", p.bc, names.len());
        }
        let per = if p.has_ss { 16 } else { 7 };
        let fc = p.fc;
        let mut pos = Vec::with_capacity(fc * aps * 3);
        let mut mats: Vec<M3> = Vec::with_capacity(fc * aps);
        for f in 0..fc {
            let locals: Vec<M4> = (0..p.bc)
                .map(|b| {
                    let s = &p.data[(f * p.bc + b) * per..(f * p.bc + b + 1) * per];
                    let v = |i: usize| f64::from(s[i]);
                    let mut r = quat_to_mat3([v(3), v(4), v(5), v(6)]);
                    if p.has_ss {
                        let ss: M3 = std::array::from_fn(|i| std::array::from_fn(|j| v(7 + i * 3 + j)));
                        r = mul3(&r, &ss);
                    }
                    trs([v(0), v(1), v(2)], &r)
                })
                .collect();
            let world = compose_world(&locals, &parents);
            for &i in &idx {
                let w = &world[i];
                pos.extend_from_slice(&[w[0][3], w[1][3], w[2][3]]);
                mats.push(std::array::from_fn(|r| std::array::from_fn(|c| w[r][c])));
            }
        }
        let rigid = is_rigid(&mats);
        let quat: Vec<[f64; 4]> = mats.iter().map(mat3_to_quat).collect();
        let pos_s = Series { k: 3, v: pos };
        let rot_s = if rigid {
            Series { k: 4, v: quat.iter().flatten().copied().collect() }
        } else {
            Series { k: 9, v: mats.iter().flat_map(|m| m.iter().flatten().copied()).collect() }
        };
        let end = trim_held(&pos_s, &rot_s, aps, fc);
        let end = drop_wrap_frame(&pos_s, &rot_s, aps, end);
        if end < 1 {
            continue;
        }
        if !has_motion(&pos_s, &rot_s, aps, end) {
            statics += 1;
            continue;
        }
        let p0: Vec<[f64; 3]> = (0..aps).map(|a| std::array::from_fn(|c| pos_s.v[a * 3 + c])).collect();
        frame0.push((aname.clone(), p0, quat[..aps].to_vec(), mats[..aps].to_vec()));
        let mut rec = Vec::with_capacity(end * aps * if rigid { 7 } else { 12 });
        for f in 0..end {
            for a in 0..aps {
                let j = f * aps + a;
                rec.extend_from_slice(&pos_s.v[j * 3..j * 3 + 3]);
                if rigid {
                    rec.extend_from_slice(&quat[j]);
                } else {
                    let m = &mats[j];
                    rec.extend((0..3).flat_map(|c| (0..3).map(move |r| m[r][c])));
                }
            }
        }
        if !o.dry {
            let magic = if rigid { MAGIC } else { MAGIC2 };
            total += write_anim(&outdir.join(format!("{aname}.anim")), magic, &ap_keys, p.fps, end, &rec)?;
        } else {
            let nb = key_blob(&ap_keys).len();
            total += 24 + nb + end * aps * if rigid { 28 } else { 48 };
        }
        meta.insert(aname, json!({"fps": p.fps, "frames": end}));
    }

    let names0: Vec<String> = frame0.iter().map(|f| f.0.clone()).collect();
    let rest_from = rest_clip(&names0);
    if let Some(rf) = &rest_from {
        let (_, p0, q0, m0) = frame0.iter().find(|f| &f.0 == rf).expect("rest clip");
        rest = Map::new();
        for (a, k) in ap_keys.iter().enumerate() {
            let r = if is_rigid([&m0[a]]) { quat_to_mat3(q0[a]) } else { m0[a] };
            rest.insert(k.clone(), pyjson::floats(col_major(&trs(p0[a], &r))));
        }
    }
    if !o.dry {
        for e in std::fs::read_dir(&outdir)? {
            let p = e?.path();
            let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
            if let Some(stem) = name.strip_suffix(".anim")
                && !meta.contains_key(stem)
            {
                std::fs::remove_file(&p)?;
            }
        }
    }
    Ok(Some(Built { ap_keys, rest, meta, total, bones, rest_from, statics }))
}

fn py_list_repr(v: &[String]) -> String {
    let inner: Vec<String> = v.iter().map(|s| format!("'{s}'")).collect();
    format!("[{}]", inner.join(", "))
}

pub fn run(o: &Opts) -> Result<()> {
    let mut stems: Vec<String> = std::fs::read_dir(o.cache)
        .with_context(|| format!("reading {}", o.cache.display()))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join("_bones.json").exists())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    stems.sort();
    if let Some(only) = o.only {
        stems.retain(|s| s.to_lowercase().contains(&only.to_lowercase()));
    }
    let (mut total, mut clips, mut rigs, mut statics) = (0usize, 0usize, 0usize, 0usize);
    let mut drift: Vec<(String, f64, usize, usize, Vec<String>)> = Vec::new();
    stems.retain(|s| o.rigs.join(format!("{s}.rig.json")).exists());
    let next = std::sync::atomic::AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).min(stems.len().max(1));
    let mut built: Vec<Option<Result<Option<Built>>>> = (0..stems.len()).map(|_| None).collect();
    let results = std::sync::Mutex::new(&mut built);
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| {
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(stem) = stems.get(i) else { break };
                    let r = build(stem, o);
                    results.lock().expect("lock")[i] = Some(r);
                }
            });
        }
    });
    for (stem, b) in stems.iter().zip(built) {
        let rigpath = o.rigs.join(format!("{stem}.rig.json"));
        let Some(b) = b.expect("built")? else { continue };
        statics += b.statics;
        let mut old: Map<String, Value> = serde_json::from_slice(&std::fs::read(&rigpath)?)?;
        if let Some(Value::Object(orest)) = old.get("rest")
            && !orest.is_empty()
        {
            let shared: Vec<&String> = orest.keys().filter(|k| b.rest.contains_key(*k)).collect();
            if !shared.is_empty() {
                let dmax = shared
                    .iter()
                    .map(|k| maxdiff(&floats_of(&orest[*k]), &floats_of(&b.rest[*k])))
                    .fold(f64::MIN, f64::max);
                let a: BTreeSet<&String> = orest.keys().collect();
                let c: BTreeSet<&String> = b.rest.keys().collect();
                let miss: Vec<String> = a.symmetric_difference(&c).map(|s| (*s).clone()).collect();
                if dmax > 1e-4 || !miss.is_empty() {
                    drift.push((stem.clone(), dmax, orest.len(), b.rest.len(), miss.into_iter().take(4).collect()));
                }
            }
        }
        if !o.dry {
            old.insert("voxel_scale".into(), pyjson::f(VOXEL_SCALE));
            old.insert("ap_keys".into(), json!(b.ap_keys));
            old.insert("rest".into(), Value::Object(b.rest.clone()));
            let rl: Vec<Value> = b.bones["rest_local"]
                .as_array()
                .context("rest_local")?
                .iter()
                .map(|x| pyjson::floats(floats_of(&x["pos"]).into_iter().chain(floats_of(&x["quat"])).map(round6)))
                .collect();
            old.insert(
                "bones".into(),
                json!({"names": b.bones["names"], "parents": b.bones["parents"], "rest_local": rl}),
            );
            old.insert("animations".into(), Value::Object(b.meta.clone()));
            match &b.rest_from {
                Some(r) => {
                    old.insert("rest_from".into(), json!(r));
                }
                None => {
                    old.shift_remove("rest_from");
                }
            }
            pyjson::write(&rigpath, &Value::Object(old), Style::Default, false)?;
        }
        total += b.total;
        clips += b.meta.len();
        rigs += 1;
    }
    println!(
        "rigs updated: {rigs}   clips: {clips}   .anim bytes: {:.1} MB   dropped {statics} motionless clips",
        total as f64 / 1024.0 / 1024.0
    );
    if !drift.is_empty() {
        println!("\nrest-pose divergence vs the old skeleton.gr2-derived rigs ({}):", drift.len());
        for (stem, dmax, n_old, n_new, miss) in drift.iter().take(20) {
            let m = if miss.is_empty() { String::new() } else { py_list_repr(miss) };
            println!("  {stem:<40} max {dmax:.5}  aps {n_old}->{n_new} {m}");
        }
    }
    Ok(())
}

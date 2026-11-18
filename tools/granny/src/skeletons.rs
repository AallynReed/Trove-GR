//! Skeleton extraction (one file or every base rig) and bind-pose rest rigs.

use crate::granny::{Bone, Granny};
use crate::pyjson::{self, Style};
use crate::source::Models;
use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};
use std::path::Path;

fn floats(v: &[f32]) -> Value {
    pyjson::floats(v.iter().map(|&x| f64::from(x)))
}

fn utf8(b: &[u8]) -> Result<String> {
    Ok(std::str::from_utf8(b).context("'utf-8' codec can't decode bone name")?.to_owned())
}

fn bone_json(b: &Bone, full: bool) -> Result<Value> {
    let t = b.local_transform;
    let mut m = Map::new();
    m.insert("name".into(), json!(utf8(b.name_bytes().unwrap_or(b"?"))?));
    m.insert("parent".into(), json!(b.parent_index));
    if full {
        m.insert("flags".into(), json!(t.flags));
    }
    m.insert("pos".into(), floats(&{ t.position }));
    m.insert("quat".into(), floats(&{ t.orientation }));
    m.insert("scaleshear".into(), Value::Array({ t.scale_shear }.iter().map(|r| floats(r)).collect()));
    if full {
        m.insert("inv_world".into(), floats(&{ b.inverse_world_4x4 }));
    }
    Ok(Value::Object(m))
}

fn skeleton_json(g: &Granny, bytes: &[u8], full: bool) -> Result<Option<Value>> {
    let Some(f) = g.open(bytes) else { bail!("read-fail") };
    let info = f.info().context("GrannyGetFileInfo returned NULL")?;
    let Some(skel) = info.skeleton() else { return Ok(None) };
    let bones: Vec<Value> = skel.bones().iter().map(|b| bone_json(b, full)).collect::<Result<_>>()?;
    let mut m = Map::new();
    m.insert("skeleton".into(), json!(utf8(skel.name_bytes().unwrap_or(b""))?));
    m.insert("bones".into(), Value::Array(bones));
    Ok(Some(Value::Object(m)))
}

pub fn one(g: &Granny, gr2: &Path, out: &Path) -> Result<()> {
    let bytes = std::fs::read(gr2)?;
    let Some(j) = skeleton_json(g, &bytes, true)? else { bail!("no skeleton in {}", gr2.display()) };
    let n = j["bones"].as_array().map_or(0, Vec::len);
    pyjson::write(out, &j, Style::Indent(1), false)?;
    println!("wrote {}: {n} bones", out.display());
    Ok(())
}

pub fn batch(g: &Granny, models: &Models, outdir: &Path) -> Result<()> {
    std::fs::create_dir_all(outdir)?;
    let rigs: Vec<String> = models
        .names_with_ext(".gr2")
        .into_iter()
        .filter(|n| !n.contains('@') && !n.to_lowercase().ends_with(".skeleton.gr2"))
        .collect();
    let (mut ok, mut fail, mut noskel) = (0, 0, 0);
    for name in &rigs {
        let stem = &name[..name.len() - 4];
        let out = outdir.join(format!("{stem}.skeleton.json"));
        if out.exists() {
            ok += 1;
            continue;
        }
        let r = models.read(name).and_then(|b| skeleton_json(g, &b, false));
        match r {
            Ok(Some(j)) => {
                pyjson::write(&out, &j, Style::Default, false)?;
                ok += 1;
            }
            Ok(None) => noskel += 1,
            Err(e) if e.to_string() == "read-fail" => {
                fail += 1;
                println!("read-fail: {stem}");
            }
            Err(e) => {
                fail += 1;
                println!("err: {stem} {e}");
            }
        }
    }
    println!("\ndone: {ok} extracted, {noskel} had no skeleton, {fail} failed, of {} rigs", rigs.len());
    Ok(())
}

fn qmat(q: &[f64]) -> [[f64; 3]; 3] {
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    let n = (x * x + y * y + z * z + w * w).powf(0.5);
    let n = if n == 0.0 { 1.0 } else { n };
    let (x, y, z, w) = (x / n, y / n, z / n, w / n);
    [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
    ]
}

fn fl(v: &Value) -> Vec<f64> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_f64).collect()).unwrap_or_default()
}

/// build_rigs: one bind-pose rest rig per skeleton with AP_ bones; `keep` stems are never written.
pub fn rigs(skeldir: &Path, rigdir: &Path, force: bool, keep: &[&str]) -> Result<()> {
    std::fs::create_dir_all(rigdir)?;
    let (mut made, mut skipped, mut existing) = (0, 0, 0);
    let mut files: Vec<_> = std::fs::read_dir(skeldir)?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    files.sort();
    for sp in files {
        let name = sp.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".skeleton.json") else { continue };
        if keep.contains(&stem) {
            continue;
        }
        let out = rigdir.join(format!("{stem}.rig.json"));
        if !force && out.exists() {
            existing += 1;
            continue;
        }
        let j: Value = serde_json::from_slice(&std::fs::read(&sp)?)?;
        let bones = j["bones"].as_array().context("bones")?;
        let mut ap: Vec<(String, usize)> = Vec::new();
        for (i, b) in bones.iter().enumerate() {
            let n = b["name"].as_str().unwrap_or("");
            if n.to_lowercase().starts_with("ap_") {
                let k = n.chars().skip(3).collect::<String>().to_lowercase();
                match ap.iter_mut().find(|(x, _)| *x == k) {
                    Some(e) => e.1 = i,
                    None => ap.push((k, i)),
                }
            }
        }
        if ap.is_empty() {
            skipped += 1;
            continue;
        }
        let mut locals: Vec<[[f64; 4]; 4]> = Vec::with_capacity(bones.len());
        let mut parents: Vec<i64> = Vec::with_capacity(bones.len());
        for b in bones {
            let r = qmat(&fl(&b["quat"]));
            let ss: Vec<Vec<f64>> = b["scaleshear"].as_array().context("scaleshear")?.iter().map(fl).collect();
            let p = fl(&b["pos"]);
            let mut m = [[0.0; 4]; 4];
            for i in 0..3 {
                for c in 0..3 {
                    m[i][c] = r[i][0] * ss[0][c] + r[i][1] * ss[1][c] + r[i][2] * ss[2][c];
                }
                m[i][3] = p[i];
            }
            m[3][3] = 1.0;
            locals.push(m);
            parents.push(b["parent"].as_i64().unwrap_or(-1));
        }
        fn gw(i: usize, locals: &[[[f64; 4]; 4]], parents: &[i64], w: &mut [Option<[[f64; 4]; 4]>]) -> [[f64; 4]; 4] {
            if let Some(m) = w[i] {
                return m;
            }
            let m = locals[i];
            let r = if parents[i] < 0 {
                m
            } else {
                let a = gw(parents[i] as usize, locals, parents, w);
                std::array::from_fn(|r| std::array::from_fn(|c| (0..4).fold(0.0, |s, k| s + a[r][k] * m[k][c])))
            };
            w[i] = Some(r);
            r
        }
        let mut memo = vec![None; locals.len()];
        let world: Vec<[[f64; 4]; 4]> = (0..locals.len()).map(|i| gw(i, &locals, &parents, &mut memo)).collect();
        let mut rest = Map::new();
        for (k, i) in &ap {
            let m = &world[*i];
            rest.insert(k.clone(), pyjson::floats((0..4).flat_map(|c| (0..4).map(move |r| m[r][c]))));
        }
        let mut keys: Vec<&String> = rest.keys().collect();
        keys.sort();
        let mut o = Map::new();
        o.insert("voxel_scale".into(), pyjson::f(crate::assets::VOXEL_SCALE));
        o.insert("ap_keys".into(), json!(keys));
        o.insert("rest".into(), Value::Object(rest.clone()));
        o.insert("animations".into(), json!({}));
        pyjson::write(&out, &Value::Object(o), Style::Default, false)?;
        made += 1;
    }
    let total = crate::rig_names(rigdir)?.len();
    println!("built {made} rest-pose rigs, skipped {skipped} (no AP_ attach points), left {existing} existing rigs alone");
    println!("total rigs in dir: {total}");
    Ok(())
}

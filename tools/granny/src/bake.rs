//! Sample every rig's clips through the DLL into the TPOSE1 pose cache (<cache>/<stem>/<clip>.pose + _bones.json).

use crate::granny::{Granny, Sampler, latin1};
use crate::pyjson::{self, Style};
use crate::source::Models;
use anyhow::{Result, bail};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

pub const MAGIC: &[u8; 8] = b"TPOSE1\0\0";
pub const FPS: u32 = 30;
const EPS_SS: f64 = 1e-6;

pub struct Opts<'a> {
    pub cache: &'a Path,
    pub rigs: &'a Path,
    pub clips: &'a Path,
    pub only: Option<&'a str>,
    pub limit: usize,
    pub resume: bool,
    pub jobs: usize,
}

fn clip_name(file: &str) -> String {
    let after = file.split_once('@').map_or("", |(_, a)| a);
    after.rsplit_once('.').map_or(after, |(a, _)| a).to_string()
}

fn clip_files(models: &Models, stem: &str, gsf_clips: &Value) -> BTreeMap<String, String> {
    let prefix = format!("{}@", stem.to_lowercase());
    let mut out = BTreeMap::new();
    for n in models.names() {
        let l = n.to_lowercase();
        if l.starts_with(&prefix) && l.ends_with(".gr2") {
            out.insert(clip_name(n), n.to_string());
        }
    }
    if let Some(list) = gsf_clips.get(stem).and_then(|r| r.get("clips")).and_then(Value::as_array) {
        for f in list.iter().filter_map(Value::as_str) {
            if f.contains('@') && models.exists(f) {
                out.insert(clip_name(f), f.to_string());
            }
        }
    }
    out
}

fn write_pose(path: &Path, bc: usize, frames: &[Vec<f32>], has_ss: bool) -> Result<()> {
    let mut buf = Vec::with_capacity(24 + frames.len() * frames.first().map_or(0, Vec::len) * 4);
    buf.extend_from_slice(MAGIC);
    for v in [bc as u32, frames.len() as u32, FPS] {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    buf.extend_from_slice(&[u8::from(has_ss), 0, 0, 0]);
    for fr in frames {
        for v in fr {
            buf.extend_from_slice(&v.to_le_bytes());
        }
    }
    std::fs::File::create(path)?.write_all(&buf)?;
    Ok(())
}

fn sample_clip(s: &Sampler, anim: *const crate::granny::Animation, nframes: usize) -> (Vec<Vec<f32>>, bool) {
    let control = s.play(anim);
    let bc = s.bone_count;
    let mut raw: Vec<Vec<crate::granny::Transform>> = Vec::with_capacity(nframes);
    let mut has_ss = false;
    for fr in 0..nframes {
        s.sample((fr as f64 / f64::from(FPS)) as f32);
        let row: Vec<_> = (0..bc).map(|i| s.transform(i)).collect();
        if !has_ss {
            has_ss = row.iter().any(|t| {
                let ss = t.scale_shear;
                (0..3).any(|r| (0..3).any(|c| (f64::from(ss[r][c]) - if r == c { 1.0 } else { 0.0 }).abs() > EPS_SS))
            });
        }
        raw.push(row);
    }
    s.free_control(control);
    let frames = raw
        .iter()
        .map(|row| {
            let mut flat = Vec::with_capacity(row.len() * if has_ss { 16 } else { 7 });
            for t in row {
                flat.extend_from_slice(&{ t.position });
                flat.extend_from_slice(&{ t.orientation });
                if has_ss {
                    for r in t.scale_shear {
                        flat.extend_from_slice(&r);
                    }
                }
            }
            flat
        })
        .collect();
    (frames, has_ss)
}

fn bake_creature(g: &Granny, models: &Models, rig_file: &str, stem: &str, gsf_clips: &Value, o: &Opts) -> Result<(usize, usize)> {
    let anims = clip_files(models, stem, gsf_clips);
    let outdir = o.cache.join(stem);
    let bonesjson = outdir.join("_bones.json");
    if o.resume && bonesjson.exists() {
        let have: BTreeSet<String> = std::fs::read_dir(&outdir)?
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".pose").map(str::to_owned))
            .collect();
        if anims.keys().all(|k| have.contains(k)) {
            return Ok((0, have.len()));
        }
    }
    let bytes = models.read(rig_file)?;
    let Some(rig) = g.open(&bytes) else { bail!("read-fail") };
    let Some(info) = rig.info() else { bail!("GrannyGetFileInfo returned NULL") };
    let Some(skel) = info.skeleton() else { return Ok((0, 0)) };
    let bones = skel.bones();
    let bc = bones.len();
    let names: Vec<String> = bones.iter().map(|b| latin1(b.name_bytes().unwrap_or(b"?"))).collect();
    let parents: Vec<i32> = bones.iter().map(|b| b.parent_index).collect();
    let rest_local: Vec<Value> = bones
        .iter()
        .map(|b| {
            let t = b.local_transform;
            let ss = t.scale_shear;
            json!({
                "pos": pyjson::floats(t.position.iter().map(|&v| f64::from(v))),
                "quat": pyjson::floats(t.orientation.iter().map(|&v| f64::from(v))),
                "ss": Value::Array(ss.iter().map(|r| pyjson::floats(r.iter().map(|&v| f64::from(v)))).collect()),
            })
        })
        .collect();
    std::fs::create_dir_all(&outdir)?;
    let mut bj = Map::new();
    bj.insert("skeleton".into(), json!(latin1(skel.name_bytes().unwrap_or(b"?"))));
    bj.insert("names".into(), json!(names));
    bj.insert("parents".into(), json!(parents));
    bj.insert("rest_local".into(), Value::Array(rest_local));
    pyjson::write(&bonesjson, &Value::Object(bj), Style::Default, false)?;
    let Some(model) = info.model() else { return Ok((0, 0)) };
    if anims.is_empty() {
        return Ok((0, 0));
    }
    let sampler = Sampler::new(g, model, bc as i32);
    let mut made = 0;
    for (aname, af) in &anims {
        let dst = outdir.join(format!("{aname}.pose"));
        if o.resume && dst.exists() {
            continue;
        }
        let abytes = models.read(af)?;
        let Some(afile) = g.open(&abytes) else { continue };
        let Some(ainfo) = afile.info() else { continue };
        let Some(anim) = ainfo.animation() else { continue };
        let dur = f64::from(unsafe { (*anim).duration });
        let nframes = 1.max((dur * f64::from(FPS)).round_ties_even() as i64 + 1) as usize;
        let (frames, has_ss) = sample_clip(&sampler, anim, nframes);
        if frames.is_empty() {
            continue;
        }
        write_pose(&dst, bc, &frames, has_ss)?;
        made += 1;
    }
    Ok((made, made))
}

fn targets(models: &Models, o: &Opts) -> Vec<(String, String)> {
    let mut targets: Vec<(String, String)> = Vec::new();
    for n in models.names_with_ext(".gr2") {
        if n.contains('@') || n.to_lowercase().ends_with(".skeleton.gr2") {
            continue;
        }
        let stem = n[..n.len() - 4].to_string();
        if let Some(only) = o.only
            && !stem.to_lowercase().contains(&only.to_lowercase())
        {
            continue;
        }
        if !o.rigs.join(format!("{stem}.rig.json")).exists() {
            continue;
        }
        targets.push((n, stem));
    }
    if o.limit > 0 {
        targets.truncate(o.limit);
    }
    targets
}

fn gsf_clips(o: &Opts, announce: bool) -> Result<Value> {
    if o.clips.exists() {
        return Ok(serde_json::from_slice(&std::fs::read(o.clips)?)?);
    }
    if announce {
        println!("no {} - baking <stem>@*.gr2 only (run graph first)", o.clips.display());
    }
    Ok(Value::Object(Map::new()))
}

/// How a worker process finds the same inputs.
pub struct WorkerSpec<'a> {
    pub granny: &'a Path,
    pub models: &'a Path,
    pub archived: bool,
}

impl WorkerSpec<'_> {
    fn spawn(&self, o: &Opts) -> Result<Child> {
        let mut c = Command::new(std::env::current_exe()?);
        c.arg("--granny").arg(self.granny).arg("bake-worker").arg("--models").arg(self.models);
        c.arg("--cache").arg(o.cache).arg("--rigs").arg(o.rigs).arg("--clips").arg(o.clips);
        c.arg("--limit").arg(o.limit.to_string());
        if self.archived {
            c.arg("--archived");
        }
        if let Some(only) = o.only {
            c.arg("--only").arg(only);
        }
        if !o.resume {
            c.arg("--no-resume");
        }
        Ok(c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?)
    }
}

/// Granny crashes when two threads sample at once, so a parallel bake runs one process per job.
pub fn run(g: &Granny, models: &Models, o: &Opts, spec: &WorkerSpec) -> Result<()> {
    let targets = targets(models, o);
    std::fs::create_dir_all(o.cache)?;
    let clips = gsf_clips(o, true)?;
    let t0 = Instant::now();
    let next = AtomicUsize::new(0);
    let finished = AtomicUsize::new(0);
    let totals = Mutex::new((0usize, 0usize, 0usize));
    let report = |stem: &str, r: Result<usize, String>| {
        let n = finished.fetch_add(1, Ordering::Relaxed) + 1;
        let mut t = totals.lock().expect("lock");
        match r {
            Ok(made) => {
                t.0 += 1;
                t.1 += made;
                let el = t0.elapsed().as_secs_f64();
                let eta = el / n as f64 * (targets.len() - n) as f64;
                println!(
                    "[{n:>3}/{:>3}] {stem:<44} {made:>2} clips  {el:>5.1}s elapsed  ETA {:>5.1} min",
                    targets.len(),
                    eta / 60.0
                );
            }
            Err(e) => {
                t.2 += 1;
                println!("FAIL {stem:<44} {e}");
            }
        }
    };
    let jobs = o.jobs.max(1).min(targets.len().max(1));
    if jobs == 1 {
        for (file, stem) in &targets {
            report(stem, bake_creature(g, models, file, stem, &clips, o).map(|r| r.0).map_err(|e| e.to_string()));
        }
    } else {
        std::thread::scope(|sc| -> Result<()> {
            let mut handles = Vec::new();
            for _ in 0..jobs {
                handles.push(sc.spawn(|| -> Result<()> {
                    let mut child: Option<(Child, BufReader<ChildStdout>)> = None;
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some((_, stem)) = targets.get(i) else { break };
                        let mut line = String::new();
                        for _attempt in 0..2 {
                            if child.is_none() {
                                let mut c = spec.spawn(o)?;
                                let out = BufReader::new(c.stdout.take().expect("piped"));
                                child = Some((c, out));
                            }
                            let (c, out) = child.as_mut().expect("child");
                            line.clear();
                            let sent = writeln!(c.stdin.as_mut().expect("piped"), "{i}").is_ok();
                            if sent && out.read_line(&mut line).is_ok_and(|n| n > 0) {
                                break;
                            }
                            let _ = c.kill();
                            child = None;
                            line = "FAIL worker process died".into();
                        }
                        let line = line.trim_end();
                        match line.strip_prefix("OK ") {
                            Some(m) => report(stem, Ok(m.parse().unwrap_or(0))),
                            None => report(stem, Err(line.strip_prefix("FAIL ").unwrap_or(line).to_string())),
                        }
                    }
                    if let Some((mut c, _)) = child {
                        drop(c.stdin.take());
                        let _ = c.wait();
                    }
                    Ok(())
                }));
            }
            for h in handles {
                h.join().expect("worker thread")?;
            }
            Ok(())
        })?;
    }
    let (done, clips, failed) = *totals.lock().expect("lock");
    println!(
        "\ndone: {done} creatures, {clips} clips baked, {failed} failed, {:.1} min",
        t0.elapsed().as_secs_f64() / 60.0
    );
    Ok(())
}

/// Child side of a parallel bake: reads target indexes on stdin and answers one line each.
pub fn worker(g: &Granny, models: &Models, o: &Opts) -> Result<()> {
    let targets = targets(models, o);
    let clips = gsf_clips(o, false)?;
    let stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let i: usize = line?.trim().parse()?;
        let (file, stem) = &targets[i];
        let msg = match bake_creature(g, models, file, stem, &clips, o) {
            Ok((made, _)) => format!("OK {made}"),
            Err(e) => format!("FAIL {}", e.to_string().replace('\n', " ")),
        };
        let mut w = stdout.lock();
        writeln!(w, "{msg}")?;
        w.flush()?;
    }
    Ok(())
}

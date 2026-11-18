//! trove-gr: Trove Granny files -> the viewer's rigs, animation graphs and .anim clips.

mod assets;
mod bake;
mod binfab;
mod granny;
mod graph;
mod pyjson;
mod skeletons;
mod source;

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use granny::Granny;
use serde_json::{Value, json};
use source::Models;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Parser)]
#[command(version, about = "Builds rigs, animation graphs and .anim clips from Trove's Granny files")]
struct Cli {
    /// granny2_x64.dll (default: GRANNY_DLL, then next to the exe)
    #[arg(long, global = true)]
    granny: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Option<Cmd>,
    #[command(flatten)]
    run: RunArgs,
}

#[derive(Args, Default)]
struct RunArgs {
    /// Trove install folder (the one holding models/ and prefabs/)
    #[arg(long)]
    trove: Option<PathBuf>,
    /// Already-extracted tree holding models/ and prefabs/
    #[arg(long)]
    from_dir: Option<PathBuf>,
    /// Output rigs folder
    #[arg(long)]
    out: Option<PathBuf>,
    /// Bake worker processes (default: one per core)
    #[arg(long)]
    jobs: Option<usize>,
    /// Keep the intermediate skeletons, pose cache and rig_clips.json in <out>/_work
    #[arg(long)]
    keep_work: bool,
}

#[derive(Subcommand)]
enum Cmd {
    /// Full pipeline (same as running with no subcommand)
    Run(RunArgs),
    /// Decompress every section of a .gr2 (Oodle1 or BitKnit) into <out>/secN.bin
    Decompress { gr2: PathBuf, out: PathBuf },
    /// One skeleton to JSON (with flags and inverse world matrices)
    Skeleton { gr2: PathBuf, out: PathBuf },
    /// Every base rig's skeleton to <out>/<stem>.skeleton.json
    Skeletons {
        #[arg(long)]
        models: PathBuf,
        #[arg(long, default_value = "skeletons")]
        out: PathBuf,
    },
    /// Bind-pose rest rigs from extracted skeletons
    Rigs {
        #[arg(long, default_value = "skeletons")]
        skeletons: PathBuf,
        #[arg(long, default_value = "rigs")]
        rigs: PathBuf,
        #[arg(long)]
        force: bool,
    },
    /// Animation state machines -> <out>/<rig>.graph.json and rig_clips.json
    Graph {
        #[arg(long)]
        models: PathBuf,
        #[arg(long)]
        prefabs: PathBuf,
        #[arg(long, default_value = "rigs/graph")]
        out: PathBuf,
        #[arg(long, default_value = "rig_clips.json")]
        clips: PathBuf,
        #[arg(long)]
        only: Option<String>,
        #[arg(long)]
        dry: bool,
    },
    /// Sample every clip into the TPOSE1 pose cache
    Bake {
        #[arg(long)]
        models: PathBuf,
        #[arg(long, default_value = "posecache")]
        cache: PathBuf,
        #[arg(long, default_value = "rigs")]
        rigs: PathBuf,
        #[arg(long, default_value = "rig_clips.json")]
        clips: PathBuf,
        #[arg(long)]
        only: Option<String>,
        #[arg(long, default_value_t = 0)]
        limit: usize,
        #[arg(long)]
        no_resume: bool,
        #[arg(long)]
        jobs: Option<usize>,
    },
    #[command(hide = true)]
    BakeWorker {
        #[arg(long)]
        models: PathBuf,
        #[arg(long)]
        archived: bool,
        #[arg(long)]
        cache: PathBuf,
        #[arg(long)]
        rigs: PathBuf,
        #[arg(long)]
        clips: PathBuf,
        #[arg(long)]
        only: Option<String>,
        #[arg(long, default_value_t = 0)]
        limit: usize,
        #[arg(long)]
        no_resume: bool,
    },
    /// Pose cache -> rig JSONs and TANIM1/TANIM2 clips (no DLL)
    Assets {
        #[arg(long, default_value = "posecache")]
        cache: PathBuf,
        #[arg(long, default_value = "rigs")]
        rigs: PathBuf,
        #[arg(long)]
        only: Option<String>,
        #[arg(long)]
        dry: bool,
    },
    /// Write <rigs>/index.json listing every rig
    Index {
        #[arg(long, default_value = "rigs")]
        rigs: PathBuf,
    },
}

pub fn rig_names(dir: &Path) -> Result<Vec<String>> {
    let mut v: Vec<String> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".rig.json").map(str::to_owned))
            .collect(),
        Err(_) => vec![],
    };
    v.sort();
    Ok(v)
}

fn jobs(j: Option<usize>) -> usize {
    j.unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
}

fn load(granny: Option<&Path>) -> Result<Granny> {
    let g = Granny::load(&granny::dll_path(granny))?;
    eprintln!("granny {}", g.version);
    Ok(g)
}

fn abs(p: &Path) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

/// The graph walk recurses deeply; give it room.
fn big_stack<T: Send>(f: impl FnOnce() -> T + Send) -> T {
    std::thread::scope(|s| {
        std::thread::Builder::new().stack_size(1 << 30).spawn_scoped(s, f).expect("spawn").join().expect("thread")
    })
}

fn write_index(rigs: &Path) -> Result<usize> {
    let mut list = Vec::new();
    for name in rig_names(rigs)? {
        let v: Value = serde_json::from_slice(&std::fs::read(rigs.join(format!("{name}.rig.json")))?)?;
        let aps = v.get("rest").and_then(Value::as_object).map_or(0, |m| m.len());
        let clips = v.get("animations").and_then(Value::as_object).map_or(0, |m| m.len());
        list.push(json!({"name": name, "aps": aps, "clips": clips}));
    }
    let n = list.len();
    pyjson::write(&rigs.join("index.json"), &json!({"rigs": list}), pyjson::Style::Compact, false)?;
    Ok(n)
}

fn decompress(g: &Granny, gr2: &Path, out: &Path) -> Result<()> {
    let d = std::fs::read(gr2)?;
    let u = |o: usize| -> Result<u32> {
        Ok(u32::from_le_bytes(d.get(o..o + 4).context("truncated header")?.try_into().expect("4")))
    };
    let base = 32 + u(44)? as usize;
    let num = u(48)? as usize;
    std::fs::create_dir_all(out)?;
    for i in 0..num {
        let e = base + i * 44;
        let (comp, off, packed, unpacked) = (u(e)?, u(e + 4)? as usize, u(e + 8)? as usize, u(e + 12)? as usize);
        let sec = if unpacked == 0 {
            vec![]
        } else {
            let cb = d.get(off..off + packed).context("section out of range")?;
            match comp {
                0 => cb.to_vec(),
                4 => g.decompress(comp, cb, unpacked)?,
                _ => g.decompress_whole(comp, cb, [u(e + 20)?, u(e + 24)?, unpacked as u32])?,
            }
        };
        if unpacked > 0 {
            println!(
                "sec{i}: comp={comp} {packed} -> {} (expected {unpacked}) {}",
                sec.len(),
                if sec.len() == unpacked { "OK" } else { "SIZE MISMATCH" }
            );
        }
        std::fs::write(out.join(format!("sec{i}.bin")), &sec)?;
    }
    println!("\nsaved {}", out.display());
    Ok(())
}

fn stage<T>(name: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    eprintln!("\n== {name}");
    let t = Instant::now();
    let r = f()?;
    eprintln!("== {name}: {:.1}s", t.elapsed().as_secs_f64());
    Ok(r)
}

fn run_all(gpath: Option<&Path>, a: &RunArgs) -> Result<()> {
    let out = a.out.as_deref().context("--out <dir> is required")?;
    let (root, archived) = match (&a.trove, &a.from_dir) {
        (Some(t), None) => (t.clone(), true),
        (None, Some(d)) => (d.clone(), false),
        _ => bail!("pass exactly one of --trove <install> or --from-dir <extracted tree>"),
    };
    let t0 = Instant::now();
    let g = load(gpath)?;
    let models = stage("read models", || {
        let m = if archived { Models::from_archive(&root.join("models"))? } else { Models::from_dir(&root.join("models"))? };
        eprintln!("{} model files", m.len());
        Ok(m)
    })?;
    let pairs = stage("scan prefabs", || graph::prefab_pairs(&root.join("prefabs"), archived))?;
    let work = out.join("_work");
    let (skel, cache, clips) = (work.join("skeletons"), work.join("posecache"), work.join("rig_clips.json"));
    if work.exists() {
        std::fs::remove_dir_all(&work)?;
    }
    std::fs::create_dir_all(&work)?;
    stage("skeletons", || skeletons::batch(&g, &models, &skel))?;
    stage("rest rigs", || skeletons::rigs(&skel, out, false, &[]))?;
    let gout = out.join("graph");
    stage("graphs", || {
        big_stack(|| graph::run(&g, &models, &pairs, &graph::Opts { out: &gout, clips: &clips, only: None, dry: false }))
    })?;
    let bo = bake::Opts { cache: &cache, rigs: out, clips: &clips, only: None, limit: 0, resume: false, jobs: jobs(a.jobs) };
    let (gabs, mabs) = (abs(&granny::dll_path(gpath)), abs(&root.join("models")));
    let spec = bake::WorkerSpec { granny: &gabs, models: &mabs, archived };
    stage("bake", || bake::run(&g, &models, &bo, &spec))?;
    stage("assets", || assets::run(&assets::Opts { cache: &cache, rigs: out, only: None, dry: false }))?;
    let n = write_index(out)?;
    if !a.keep_work {
        std::fs::remove_dir_all(&work)?;
    }
    eprintln!("\n{n} rigs in {} ({:.1}s total)", out.display(), t0.elapsed().as_secs_f64());
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let gp = cli.granny.as_deref();
    match cli.cmd {
        None => run_all(gp, &cli.run),
        Some(Cmd::Run(a)) => run_all(gp, &a),
        Some(Cmd::Decompress { gr2, out }) => decompress(&load(gp)?, &gr2, &out),
        Some(Cmd::Skeleton { gr2, out }) => skeletons::one(&load(gp)?, &gr2, &out),
        Some(Cmd::Skeletons { models, out }) => skeletons::batch(&load(gp)?, &Models::from_dir(&models)?, &out),
        Some(Cmd::Rigs { skeletons, rigs, force }) => skeletons::rigs(&skeletons, &rigs, force, &["companion_spidermonkey"]),
        Some(Cmd::Graph { models, prefabs, out, clips, only, dry }) => {
            let g = load(gp)?;
            let m = Models::from_dir(&models)?;
            let pairs = graph::prefab_pairs(&prefabs, false)?;
            big_stack(|| graph::run(&g, &m, &pairs, &graph::Opts { out: &out, clips: &clips, only: only.as_deref(), dry }))
        }
        Some(Cmd::Bake { models, cache, rigs, clips, only, limit, no_resume, jobs: j }) => {
            let g = load(gp)?;
            let o = bake::Opts {
                cache: &cache,
                rigs: &rigs,
                clips: &clips,
                only: only.as_deref(),
                limit,
                resume: !no_resume,
                jobs: jobs(j),
            };
            let (gabs, mabs) = (abs(&granny::dll_path(gp)), abs(&models));
            let spec = bake::WorkerSpec { granny: &gabs, models: &mabs, archived: false };
            bake::run(&g, &Models::from_dir(&models)?, &o, &spec)
        }
        Some(Cmd::BakeWorker { models, archived, cache, rigs, clips, only, limit, no_resume }) => {
            let g = Granny::load(&granny::dll_path(gp))?;
            let m = if archived { Models::from_archive(&models)? } else { Models::from_dir(&models)? };
            let o = bake::Opts {
                cache: &cache,
                rigs: &rigs,
                clips: &clips,
                only: only.as_deref(),
                limit,
                resume: !no_resume,
                jobs: 1,
            };
            bake::worker(&g, &m, &o)
        }
        Some(Cmd::Assets { cache, rigs, only, dry }) => {
            assets::run(&assets::Opts { cache: &cache, rigs: &rigs, only: only.as_deref(), dry })
        }
        Some(Cmd::Index { rigs }) => {
            let n = write_index(&rigs)?;
            println!("{n} rigs in {}", rigs.join("index.json").display());
            Ok(())
        }
    }
}

//! Game files, from an extracted folder or straight from a Trove install's .tfi/.tfa archives.

use anyhow::{Context, Result, bail};
use flate2::{Decompress, FlushDecompress, Status};
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;

enum Loc {
    Path(PathBuf),
    Mem(Arc<Vec<u8>>, Range<usize>),
}

/// One flat folder of models (`.gr2`, `.gsf`), looked up case-insensitively like Windows does.
pub struct Models {
    files: BTreeMap<String, (String, Loc)>,
}

impl Models {
    pub fn from_dir(dir: &Path) -> Result<Models> {
        let mut files = BTreeMap::new();
        for e in std::fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
            let e = e?;
            if !e.file_type()?.is_file() {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            files.insert(name.to_lowercase(), (name, Loc::Path(e.path())));
        }
        Ok(Models { files })
    }

    pub fn from_archive(dir: &Path) -> Result<Models> {
        let mut files = BTreeMap::new();
        for (name, content, range) in read_archive_dir(dir)? {
            if name.contains('/') || name.starts_with('.') {
                continue;
            }
            files.insert(name.to_lowercase(), (name, Loc::Mem(content, range)));
        }
        Ok(Models { files })
    }

    /// Original-case names ending in `ext` (case-insensitive), sorted like Python's sorted(glob()).
    pub fn names_with_ext(&self, ext: &str) -> Vec<String> {
        let mut v: Vec<String> =
            self.files.iter().filter(|(k, _)| k.ends_with(ext)).map(|(_, (n, _))| n.clone()).collect();
        v.sort();
        v
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.files.values().map(|(n, _)| n.as_str())
    }

    pub fn exists(&self, name: &str) -> bool {
        self.files.contains_key(&name.to_lowercase())
    }

    pub fn read(&self, name: &str) -> Result<Cow<'_, [u8]>> {
        match self.files.get(&name.to_lowercase()) {
            Some((_, Loc::Path(p))) => Ok(Cow::Owned(std::fs::read(p)?)),
            Some((_, Loc::Mem(c, r))) => Ok(Cow::Borrowed(&c[r.clone()])),
            None => bail!("{name} not found"),
        }
    }

    pub fn len(&self) -> usize {
        self.files.len()
    }
}

/// Calls `f(data)` for every `.binfab` under `dir` (an extracted tree or an install's archived one).
pub fn each_binfab(dir: &Path, archived: bool, f: &mut dyn FnMut(&[u8])) -> Result<usize> {
    let mut n = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let mut entries: Vec<_> = std::fs::read_dir(&d)?.collect::<std::io::Result<_>>()?;
        entries.sort_by_key(|e| e.file_name());
        for e in &entries {
            let ft = e.file_type()?;
            if ft.is_dir() {
                stack.push(e.path());
            } else if !archived && e.file_name().to_string_lossy().ends_with(".binfab") {
                f(&std::fs::read(e.path())?);
                n += 1;
            }
        }
        if archived && d.join("index.tfi").is_file() {
            for (name, content, range) in read_archive_dir(&d)? {
                if name.ends_with(".binfab") {
                    f(&content[range]);
                    n += 1;
                }
            }
        }
    }
    Ok(n)
}

pub struct TfiEntry {
    pub name: String,
    pub archive: u32,
    pub offset: u32,
    pub size: u32,
    pub hash: u32,
}

/// Trove's FNV-1a variant over 4-byte words; the tail bytes are read as signed chars.
pub fn trove_hash(data: &[u8]) -> u32 {
    const PRIME: u32 = 16_777_619;
    let se = |b: u8| b as i8 as i32 as u32;
    let mut h: u32 = 2_166_136_261;
    let mut words = data.chunks_exact(4);
    for w in &mut words {
        h = PRIME.wrapping_mul(h ^ u32::from_le_bytes([w[0], w[1], w[2], w[3]]));
    }
    let val = match *words.remainder() {
        [] => return h,
        [a] => se(a),
        [a, b] => (se(a) << 8) | se(b),
        [a, b, c] => (((se(a) << 8) | se(b)) << 8) | se(c),
        _ => unreachable!(),
    };
    PRIME.wrapping_mul(h ^ val)
}

fn read_leb128(buf: &[u8], mut pos: usize) -> Result<(u32, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0;
    loop {
        let Some(&b) = buf.get(pos) else { bail!("malformed .tfi: truncated varint") };
        pos += 1;
        result |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Ok((result as u32, pos));
        }
        shift += 7;
        if shift >= 64 {
            bail!("malformed .tfi: varint too long");
        }
    }
}

pub fn parse_tfi(data: &[u8]) -> Result<Vec<TfiEntry>> {
    let mut out = Vec::new();
    let mut pos = 0;
    let n = data.len();
    while pos < n {
        let (len, p) = read_leb128(data, pos)?;
        let end = p.saturating_add(len as usize);
        let raw = &data[p.min(n)..end.min(n)];
        let raw = raw.split(|&b| b == 0).next().unwrap_or(&[]);
        let name = std::str::from_utf8(raw).context("malformed .tfi name")?.replace('\\', "/");
        let (archive, p) = read_leb128(data, end)?;
        let (offset, p) = read_leb128(data, p)?;
        let (size, p) = read_leb128(data, p)?;
        let (hash, p) = read_leb128(data, p)?;
        pos = p;
        out.push(TfiEntry { name, archive, offset, size, hash });
    }
    Ok(out)
}

/// The archives are sync-flushed zlib without a final block: keep whatever decodes.
fn inflate(raw: &[u8], hint: usize) -> Result<Vec<u8>> {
    let mut d = Decompress::new(true);
    let mut out = Vec::with_capacity(hint.max(256));
    loop {
        if out.len() == out.capacity() {
            out.reserve(out.len().max(4096));
        }
        let (in0, out0) = (d.total_in(), d.total_out());
        let status = d.decompress_vec(&raw[in0 as usize..], &mut out, FlushDecompress::None).context("could not inflate .tfa")?;
        if status == Status::StreamEnd {
            return Ok(out);
        }
        if d.total_in() == in0 && d.total_out() == out0 && out.len() < out.capacity() {
            return Ok(out);
        }
    }
}

/// Every file indexed by `dir/index.tfi`, as (name, archive contents, byte range).
pub fn read_archive_dir(dir: &Path) -> Result<Vec<(String, Arc<Vec<u8>>, Range<usize>)>> {
    let tfi = std::fs::read(dir.join("index.tfi")).with_context(|| format!("reading {}/index.tfi", dir.display()))?;
    let entries = parse_tfi(&tfi)?;
    let mut archives: BTreeMap<u32, Arc<Vec<u8>>> = BTreeMap::new();
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        let content = match archives.get(&e.archive) {
            Some(c) => c.clone(),
            None => {
                let path = dir.join(format!("archive{}.tfa", e.archive));
                let raw = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
                let c = Arc::new(inflate(&raw, raw.len() * 4)?);
                archives.insert(e.archive, c.clone());
                c
            }
        };
        let len = content.len();
        let start = (e.offset as usize).min(len);
        let end = (e.offset as usize).saturating_add(e.size as usize).min(len).max(start);
        if trove_hash(&content[start..end]) != e.hash {
            eprintln!("warning: checksum mismatch for {}/{}", dir.display(), e.name);
        }
        out.push((e.name, content, start..end));
    }
    Ok(out)
}

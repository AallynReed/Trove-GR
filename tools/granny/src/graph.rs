//! A rig's .gsf animation state machine -> graph/<rig>.graph.json, plus rig_clips.json for the bake.

use crate::binfab::real_fields;
use crate::granny::{DataTypeDef, Granny};
use crate::pyjson::{self, Style, round6};
use crate::source::{Models, each_binfab};
use anyhow::Result;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

const END: i32 = 0;
const INLINE: i32 = 1;
const REFERENCE: i32 = 2;
const REF_TO_ARRAY: i32 = 3;
const ARRAY_OF_REFS: i32 = 4;
const VARIANT_REF: i32 = 5;
const REF_TO_VARIANT_ARRAY: i32 = 7;
const STRING: i32 = 8;
const REAL32: i32 = 10;
const REAL16: i32 = 21;
const EMPTY_REF: i32 = 22;

#[derive(Clone)]
enum Val {
    None,
    Int(i64),
    Float(f64),
    Str(String),
    List(Vec<Val>),
    Obj(usize),
    Ref(usize),
}

impl Val {
    fn truthy(&self) -> bool {
        match self {
            Val::None => false,
            Val::Int(i) => *i != 0,
            Val::Float(f) => *f != 0.0,
            Val::Str(s) => !s.is_empty(),
            Val::List(l) => !l.is_empty(),
            Val::Obj(_) | Val::Ref(_) => true,
        }
    }
    fn obj(&self) -> Option<usize> {
        match self {
            Val::Obj(id) | Val::Ref(id) => Some(*id),
            _ => None,
        }
    }
    /// What Python's json.dumps writes for the walked value (a first visit expands the object).
    fn json(&self, by_id: &[Object]) -> Value {
        match self {
            Val::None => Value::Null,
            Val::Obj(id) => Value::Object(by_id[id - 1].iter().map(|(k, v)| (k.clone(), v.json(by_id))).collect()),
            Val::Ref(id) => json!({"$ref": id}),
            Val::Int(i) => json!(i),
            Val::Float(f) => pyjson::f(*f),
            Val::Str(s) => Value::String(s.clone()),
            Val::List(l) => Value::Array(l.iter().map(|v| v.json(by_id)).collect()),
        }
    }
    fn round6(&self, by_id: &[Object]) -> Value {
        match self {
            Val::Float(f) => pyjson::f(round6(*f)),
            v => v.json(by_id),
        }
    }
}

type Object = Vec<(String, Val)>;

struct Walker<'g> {
    g: &'g Granny,
    by_id: Vec<Object>,
    ids: HashMap<usize, usize>,
    obj_size: HashMap<usize, usize>,
}

fn members(type_ptr: usize) -> Vec<(DataTypeDef, usize)> {
    let mut out = Vec::new();
    let mut p = type_ptr;
    loop {
        let m: DataTypeDef = unsafe { std::ptr::read_unaligned(p as *const DataTypeDef) };
        let ty = m.ty;
        if ty == END || !(0..=EMPTY_REF).contains(&ty) {
            return out;
        }
        out.push((m, p));
        p += size_of::<DataTypeDef>();
    }
}

unsafe fn rd<T: Copy>(addr: usize) -> T {
    unsafe { std::ptr::read_unaligned(addr as *const T) }
}

impl Walker<'_> {
    fn member_size(&self, p: usize) -> usize {
        unsafe { (self.g.member_type_size)(p as *const DataTypeDef) as isize as usize }
    }

    fn object_size(&mut self, type_ptr: usize) -> usize {
        if let Some(&s) = self.obj_size.get(&type_ptr) {
            return s;
        }
        let s = members(type_ptr).iter().map(|(_, p)| self.member_size(*p)).sum();
        self.obj_size.insert(type_ptr, s);
        s
    }

    fn walk(&mut self, type_ptr: usize, obj_ptr: usize) -> Val {
        if type_ptr == 0 || obj_ptr == 0 {
            return Val::None;
        }
        if let Some(&id) = self.ids.get(&obj_ptr) {
            return Val::Ref(id);
        }
        self.by_id.push(Vec::new());
        let id = self.by_id.len();
        self.ids.insert(obj_ptr, id);
        self.by_id[id - 1].push(("$id".into(), Val::Int(id as i64)));
        let mut off = 0;
        for (m, mp) in members(type_ptr) {
            let name = crate::granny::cbytes(m.name).map_or("?".to_string(), |b| String::from_utf8_lossy(b).into_owned());
            let v = self.value(&m, obj_ptr + off);
            let obj = &mut self.by_id[id - 1];
            match obj.iter_mut().find(|(k, _)| *k == name) {
                Some(slot) => slot.1 = v,
                None => obj.push((name, v)),
            }
            off += self.member_size(mp);
        }
        Val::Obj(id)
    }

    fn value(&mut self, m: &DataTypeDef, addr: usize) -> Val {
        let t = m.ty;
        let w = m.array_width.max(1) as usize;
        let rt = m.reference_type as usize;
        unsafe {
            match t {
                STRING => {
                    let p: usize = rd(addr);
                    crate::granny::cbytes(p as *const _)
                        .map_or(Val::None, |b| Val::Str(String::from_utf8_lossy(b).into_owned()))
                }
                10..=20 => {
                    let one = |i: usize| -> Val {
                        match t {
                            REAL32 => Val::Float(f64::from(rd::<f32>(addr + i * 4))),
                            11 | 13 => Val::Int(i64::from(rd::<i8>(addr + i))),
                            12 | 14 => Val::Int(i64::from(rd::<u8>(addr + i))),
                            15 | 17 => Val::Int(i64::from(rd::<i16>(addr + i * 2))),
                            16 | 18 => Val::Int(i64::from(rd::<u16>(addr + i * 2))),
                            19 => Val::Int(i64::from(rd::<i32>(addr + i * 4))),
                            _ => Val::Int(i64::from(rd::<u32>(addr + i * 4))),
                        }
                    };
                    if w == 1 { one(0) } else { Val::List((0..w).map(one).collect()) }
                }
                INLINE => self.walk(rt, addr),
                REFERENCE => self.walk(rt, rd(addr)),
                REF_TO_ARRAY | ARRAY_OF_REFS => {
                    let n: i32 = rd(addr);
                    let arr: usize = rd(addr + 4);
                    if arr == 0 || n <= 0 {
                        return Val::List(vec![]);
                    }
                    if t == ARRAY_OF_REFS {
                        return Val::List((0..n as usize).map(|i| self.walk(rt, rd(arr + i * 8))).collect());
                    }
                    let stride = self.object_size(rt);
                    Val::List((0..n as usize).map(|i| self.walk(rt, arr + i * stride)).collect())
                }
                VARIANT_REF => self.walk(rd(addr), rd(addr + 8)),
                REF_TO_VARIANT_ARRAY => {
                    let vt: usize = rd(addr);
                    let n: i32 = rd(addr + 8);
                    let arr: usize = rd(addr + 12);
                    if vt == 0 || arr == 0 || n <= 0 {
                        return Val::List(vec![]);
                    }
                    let stride = self.object_size(vt);
                    Val::List((0..n as usize).map(|i| self.walk(vt, arr + i * stride)).collect())
                }
                REAL16 => Val::List((0..w).map(|i| Val::Int(i64::from(rd::<u16>(addr + i * 2)))).collect()),
                _ => Val::None,
            }
        }
    }
}

pub struct Graph {
    pub json: Map<String, Value>,
    pub sources: Vec<(String, Option<String>)>,
    pub edge_count: usize,
    pub node_count: usize,
    pub slot_count: usize,
}

fn condense(by_id: &[Object], root: usize) -> Graph {
    let get = |id: usize, key: &str| -> Option<&Val> { by_id[id - 1].iter().find(|(k, _)| k == key).map(|(_, v)| v) };
    let has = |id: usize, key: &str| by_id[id - 1].iter().any(|(k, _)| k == key);
    let getv = |id: usize, key: &str| get(id, key).cloned().unwrap_or(Val::None);
    let obj_of = |id: usize, key: &str| get(id, key).and_then(Val::obj);
    let truthy = |id: usize, key: &str| get(id, key).is_some_and(Val::truthy);
    let kind_of = |id: usize| -> Option<String> {
        by_id[id - 1].iter().find_map(|(k, _)| k.strip_prefix("ContextUID_").map(str::to_owned))
    };
    let list = |id: usize, key: &str| -> Vec<Val> {
        match get(id, key) {
            Some(Val::List(l)) => l.clone(),
            _ => vec![],
        }
    };

    let mut slots: BTreeMap<i64, Val> = BTreeMap::new();
    for s in list(root, "AnimationSlots") {
        if let Some(s) = s.obj()
            && !matches!(getv(s, "Name"), Val::None)
            && let Val::Int(k) = getv(s, "SlotIndex")
        {
            slots.insert(k, getv(s, "Name"));
        }
    }

    let mut sources: Vec<(String, Option<String>)> = Vec::new();
    for st in list(root, "AnimationSets") {
        let Some(st) = st.obj() else { continue };
        for spec in list(st, "AnimationSpecs") {
            let Some(spec) = spec.obj() else { continue };
            let src = obj_of(spec, "SourceReference").map(|r| getv(r, "SourceFilename"));
            if let Val::Str(name) = getv(spec, "ExpectedName")
                && !name.is_empty()
            {
                let src = match src {
                    Some(Val::Str(s)) => s,
                    _ => String::new(),
                };
                let base = src.replace('\\', "/").rsplit('/').next().unwrap_or("").to_string();
                let base = (!base.is_empty()).then_some(base);
                match sources.iter_mut().find(|(k, _)| *k == name) {
                    Some(e) => e.1 = base,
                    None => sources.push((name, base)),
                }
            }
        }
    }

    let mut nodes: BTreeMap<usize, Map<String, Value>> = BTreeMap::new();
    let mut parents: BTreeMap<usize, Option<usize>> = BTreeMap::new();
    let mut edges: Vec<Value> = Vec::new();
    for id in 1..=by_id.len() {
        let Some(kind) = kind_of(id) else { continue };
        let payload = obj_of(id, &format!("{kind}Token"));
        if let Some(node) = obj_of(id, "nodeToken")
            && has(node, "Name")
        {
            let mut e = Map::new();
            e.insert("name".into(), getv(node, "Name").json(by_id));
            e.insert("kind".into(), json!(kind));
            let parent = obj_of(node, "ParentToken");
            if let Some(p) = parent {
                e.insert("parent".into(), json!(p));
            }
            if kind == "anim_source"
                && let Some(pl) = payload
            {
                if let Some(slot) = obj_of(pl, "AnimationSlot")
                    && truthy(slot, "Name")
                {
                    e.insert("clip".into(), getv(slot, "Name").json(by_id));
                    e.insert("slot".into(), getv(slot, "SlotIndex").json(by_id));
                }
                if !matches!(getv(pl, "Speed"), Val::None) {
                    e.insert("speed".into(), getv(pl, "Speed").round6(by_id));
                }
                e.insert("loop".into(), json!(truthy(pl, "ClampedLooping")));
            }
            nodes.insert(id, e);
            parents.insert(id, parent);
        }
        if let Some(tr) = obj_of(id, "transitionToken")
            && (has(tr, "StartNode") || has(tr, "EndNode"))
        {
            let mut e = Map::new();
            e.insert("from".into(), json!(obj_of(tr, "StartNode")));
            e.insert("to".into(), json!(obj_of(tr, "EndNode")));
            e.insert("when".into(), json!(kind.strip_prefix("tr_").unwrap_or(&kind)));
            let blend = if truthy(tr, "Duration") { getv(tr, "Duration").round6(by_id) } else { pyjson::f(0.0) };
            e.insert("blend".into(), blend);
            if truthy(tr, "Name") {
                e.insert("name".into(), getv(tr, "Name").json(by_id));
            }
            if let Some(pl) = payload
                && !matches!(getv(pl, "Probability"), Val::None)
            {
                e.insert("probability".into(), getv(pl, "Probability").round6(by_id));
            }
            let conds = list(tr, "Conditionals");
            if !conds.is_empty() {
                let c: Vec<Value> = conds
                    .iter()
                    .filter_map(Val::obj)
                    .map(|c| {
                        let name = obj_of(c, "conditionalToken").map_or(Val::None, |t| getv(t, "Name"));
                        json!({"kind": kind_of(c), "name": name.json(by_id)})
                    })
                    .collect();
                e.insert("conditions".into(), Value::Array(c));
                if truthy(tr, "InvertConditionals") {
                    e.insert("invert".into(), getv(tr, "InvertConditionals").json(by_id));
                }
                if truthy(tr, "AndConditions") {
                    e.insert("requiresAll".into(), json!(true));
                }
            }
            if truthy(tr, "IsAnyTransition") {
                e.insert("fromAnyState".into(), json!(true));
            }
            edges.push(Value::Object(e));
        }
    }

    let mut kids: HashMap<Option<usize>, Vec<usize>> = HashMap::new();
    for (&nid, p) in &parents {
        kids.entry(*p).or_default().push(nid);
    }
    fn clips_below(
        nid: usize,
        seen: &mut BTreeSet<usize>,
        nodes: &BTreeMap<usize, Map<String, Value>>,
        kids: &HashMap<Option<usize>, Vec<usize>>,
        out: &mut BTreeSet<String>,
    ) {
        if let Some(Value::String(c)) = nodes.get(&nid).and_then(|n| n.get("clip")) {
            out.insert(c.clone());
        }
        for &k in kids.get(&Some(nid)).map_or(&[][..], Vec::as_slice) {
            if seen.insert(k) {
                clips_below(k, seen, nodes, kids, out);
            }
        }
    }
    let ids: Vec<usize> = nodes.keys().copied().collect();
    for nid in ids {
        let mut found = BTreeSet::new();
        let mut seen = BTreeSet::from([nid]);
        clips_below(nid, &mut seen, &nodes, &kids, &mut found);
        let n = nodes.get_mut(&nid).expect("node");
        let has_clip = n.get("clip").is_some_and(|c| !matches!(c, Value::Null) && c != "");
        if !found.is_empty() && !has_clip {
            n.insert("clips".into(), json!(found.into_iter().collect::<Vec<_>>()));
        }
    }

    let slot_count = slots.len();
    let node_count = nodes.len();
    let edge_count = edges.len();
    let mut j = Map::new();
    j.insert("slots".into(), Value::Object(slots.into_iter().map(|(k, v)| (k.to_string(), v.json(by_id))).collect()));
    j.insert(
        "sources".into(),
        Value::Object(sources.iter().map(|(k, v)| (k.clone(), json!(v))).collect()),
    );
    j.insert("nodes".into(), Value::Object(nodes.into_iter().map(|(k, v)| (k.to_string(), Value::Object(v))).collect()));
    j.insert("edges".into(), Value::Array(edges));
    Graph { json: j, sources, edge_count, node_count, slot_count }
}

pub fn read_graph(g: &Granny, bytes: &[u8]) -> Option<Graph> {
    let f = g.open(bytes)?;
    let var = f.data_tree();
    let (ty, obj) = (var.ty as usize, var.object as usize);
    if ty == 0 || obj == 0 {
        return None;
    }
    let mut w = Walker { g, by_id: Vec::new(), ids: HashMap::new(), obj_size: HashMap::new() };
    let root = w.walk(ty, obj).obj()?;
    Some(condense(&w.by_id, root))
}

/// skeleton stem -> the .gsf stems the prefabs pair it with (first-seen order).
pub fn prefab_pairs(prefabs: &Path, archived: bool) -> Result<HashMap<String, Vec<String>>> {
    let mut pairs: HashMap<String, Vec<String>> = HashMap::new();
    let finder = memchr::memmem::Finder::new(b".skeleton.gr2");
    each_binfab(prefabs, archived, &mut |data| {
        if finder.find(data).is_none() {
            return;
        }
        let mut skel: Option<String> = None;
        for (_, _, s) in real_fields(data) {
            let base = s.replace('\\', "/").rsplit('/').next().unwrap_or("").to_lowercase();
            if let Some(st) = base.strip_suffix(".skeleton.gr2") {
                skel = Some(st.to_string());
            } else if let Some(sk) = skel.as_ref()
                && let Some(gsf) = base.strip_suffix(".gsf")
            {
                let v = pairs.entry(sk.clone()).or_default();
                if !v.iter().any(|x| x == gsf) {
                    v.push(gsf.to_string());
                }
                skel = None;
            }
        }
    })?;
    Ok(pairs)
}

pub struct Opts<'a> {
    pub out: &'a Path,
    pub clips: &'a Path,
    pub only: Option<&'a str>,
    pub dry: bool,
}

pub fn run(g: &Granny, models: &Models, pairs: &HashMap<String, Vec<String>>, o: &Opts) -> Result<()> {
    let rigdir = o.out.parent().unwrap_or(Path::new("."));
    let mut gsfs: BTreeMap<String, String> = BTreeMap::new();
    for n in models.names_with_ext(".gsf") {
        gsfs.insert(n[..n.len() - 4].to_lowercase(), n);
    }
    let mut rigs = crate::rig_names(rigdir)?;
    if let Some(only) = o.only {
        rigs.retain(|r| r.to_lowercase().contains(&only.to_lowercase()));
    }
    if !o.dry {
        std::fs::create_dir_all(o.out)?;
    }
    let mut graphs: HashMap<String, Option<Graph>> = HashMap::new();
    let mut clips: BTreeMap<String, Value> = BTreeMap::new();
    let mut written = BTreeSet::new();
    let (mut done, mut flat, mut total) = (0, 0, 0usize);
    for rig in &rigs {
        let gsf = if gsfs.contains_key(rig.as_str()) {
            Some(rig.clone())
        } else {
            match pairs.get(rig.as_str()) {
                Some(v) if v.len() == 1 && gsfs.contains_key(&v[0]) => Some(v[0].clone()),
                _ => None,
            }
        };
        let Some(gsf) = gsf else { continue };
        if !graphs.contains_key(&gsf) {
            let bytes = models.read(&gsfs[&gsf])?;
            graphs.insert(gsf.clone(), read_graph(g, &bytes));
        }
        let Some(graph) = graphs[&gsf].as_ref() else { continue };
        let set: BTreeSet<&String> = graph.sources.iter().filter_map(|(_, v)| v.as_ref()).collect();
        clips.insert(rig.clone(), json!({"gsf": gsf, "clips": set}));
        if graph.edge_count == 0 {
            flat += 1;
            continue;
        }
        let mut j = Map::new();
        j.insert("rig".into(), json!(rig));
        j.insert("source".into(), json!(format!("models/{gsf}.gsf")));
        j.extend(graph.json.clone());
        let text = pyjson::dumps(&Value::Object(j), Style::Compact, false);
        if !o.dry {
            std::fs::write(o.out.join(format!("{rig}.graph.json")), &text)?;
        }
        written.insert(rig.clone());
        total += text.len();
        done += 1;
        println!(
            "{:<34} {:<34} {:>3} nodes  {:>3} edges  {:>3} clips  {:>5.1} KB",
            rig,
            if &gsf != rig { gsf.as_str() } else { "" },
            graph.node_count,
            graph.edge_count,
            graph.slot_count,
            text.len() as f64 / 1024.0
        );
    }
    if !o.dry {
        let mut all: Map<String, Value> = Map::new();
        if o.only.is_some() && o.clips.exists() {
            if let Value::Object(m) = serde_json::from_slice(&std::fs::read(o.clips)?)? {
                all = m;
            }
        }
        all.extend(clips);
        let n_clips = all.len();
        pyjson::write(o.clips, &Value::Object(all), Style::Indent(1), true)?;
        if o.only.is_none() {
            for e in std::fs::read_dir(o.out)? {
                let p = e?.path();
                let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
                if let Some(stem) = name.strip_suffix(".graph.json")
                    && !written.contains(stem)
                {
                    std::fs::remove_file(&p)?;
                }
            }
        }
        println!(
            "\ngraphs: {done}   no state machine: {flat}   rigs with a .gsf: {n_clips}   {:.1} MB total",
            total as f64 / 1024.0 / 1024.0
        );
    } else {
        println!(
            "\ngraphs: {done}   no state machine: {flat}   rigs with a .gsf: {}   {:.1} MB total",
            clips.len(),
            total as f64 / 1024.0 / 1024.0
        );
    }
    Ok(())
}

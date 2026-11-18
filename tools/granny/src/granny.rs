//! Runtime binding to granny2_x64.dll. Structs follow granny.h, which packs everything to 4 bytes.

use anyhow::{Context, Result, anyhow, bail};
use libloading::Library;
use std::ffi::{CStr, c_char, c_void};
use std::path::{Path, PathBuf};

pub type Ptr = *mut c_void;

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct Variant {
    pub ty: Ptr,
    pub object: Ptr,
}

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct Transform {
    pub flags: u32,
    pub position: [f32; 3],
    pub orientation: [f32; 4],
    pub scale_shear: [[f32; 3]; 3],
}

#[repr(C, packed(4))]
pub struct Bone {
    pub name: *const c_char,
    pub parent_index: i32,
    pub local_transform: Transform,
    pub inverse_world_4x4: [f32; 16],
    pub lod_error: f32,
    pub extended_data: Variant,
}

#[repr(C, packed(4))]
pub struct Skeleton {
    pub name: *const c_char,
    pub bone_count: i32,
    pub bones: *const Bone,
    pub lod_type: i32,
    pub extended_data: Variant,
}

#[repr(C, packed(4))]
pub struct Animation {
    pub name: *const c_char,
    pub duration: f32,
    pub time_step: f32,
    pub oversampling: f32,
    pub track_group_count: i32,
    pub track_groups: Ptr,
    pub default_loop_count: i32,
    pub flags: i32,
    pub extended_data: Variant,
}

#[repr(C, packed(4))]
pub struct Model {
    pub name: *const c_char,
    pub skeleton: *const Skeleton,
    pub initial_placement: Transform,
    pub mesh_binding_count: i32,
    pub mesh_bindings: Ptr,
    pub extended_data: Variant,
}

#[repr(C, packed(4))]
pub struct FileInfo {
    pub art_tool_info: Ptr,
    pub exporter_info: Ptr,
    pub from_file_name: *const c_char,
    pub texture_count: i32,
    pub textures: Ptr,
    pub material_count: i32,
    pub materials: Ptr,
    pub skeleton_count: i32,
    pub skeletons: *const *const Skeleton,
    pub vertex_data_count: i32,
    pub vertex_datas: Ptr,
    pub tri_topology_count: i32,
    pub tri_topologies: Ptr,
    pub mesh_count: i32,
    pub meshes: Ptr,
    pub model_count: i32,
    pub models: *const *const Model,
    pub track_group_count: i32,
    pub track_groups: Ptr,
    pub animation_count: i32,
    pub animations: *const *const Animation,
    pub extended_data: Variant,
}

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
pub struct DataTypeDef {
    pub ty: i32,
    pub name: *const c_char,
    pub reference_type: Ptr,
    pub array_width: i32,
    pub extra: [i32; 3],
    pub ignored: Ptr, // granny_uintaddrx: pointer-sized
}

const _: () = {
    assert!(size_of::<Variant>() == 16);
    assert!(size_of::<Transform>() == 68);
    assert!(size_of::<Bone>() == 164);
    assert!(size_of::<Skeleton>() == 40);
    assert!(size_of::<Animation>() == 56);
    assert!(size_of::<Model>() == 112);
    assert!(size_of::<FileInfo>() == 148);
    assert!(size_of::<DataTypeDef>() == 44);
};

type Bool = u8; // C++ bool: one byte

pub struct Granny {
    _lib: Library,
    pub version: String,
    read_from_memory: unsafe extern "system" fn(i32, *const c_void) -> Ptr,
    free_file: unsafe extern "system" fn(Ptr),
    get_file_info: unsafe extern "system" fn(Ptr) -> *const FileInfo,
    begin_decompression: unsafe extern "system" fn(i32, Bool, i32, *mut c_void, i32, *mut c_void) -> Ptr,
    decompress_incremental: unsafe extern "system" fn(Ptr, i32, *const c_void) -> Bool,
    end_decompression: unsafe extern "system" fn(Ptr) -> Bool,
    decompress_data: unsafe extern "system" fn(i32, Bool, i32, *mut c_void, i32, i32, i32, *mut c_void) -> Bool,
    padding_size: unsafe extern "system" fn(i32) -> i32,
    get_data_tree: unsafe extern "system" fn(Ptr, *mut Variant),
    pub member_type_size: unsafe extern "system" fn(*const DataTypeDef) -> i32,
    instantiate_model: unsafe extern "system" fn(*const Model) -> Ptr,
    free_model_instance: unsafe extern "system" fn(Ptr),
    play_controlled_animation: unsafe extern "system" fn(f32, *const Animation, Ptr) -> Ptr,
    free_control: unsafe extern "system" fn(Ptr),
    set_model_clock: unsafe extern "system" fn(Ptr, f32),
    new_local_pose: unsafe extern "system" fn(i32) -> Ptr,
    free_local_pose: unsafe extern "system" fn(Ptr),
    sample_model_animations: unsafe extern "system" fn(Ptr, i32, i32, Ptr),
    get_local_pose_transform: unsafe extern "system" fn(Ptr, i32) -> *const Transform,
}

unsafe impl Send for Granny {}
unsafe impl Sync for Granny {}

pub fn dll_path(arg: Option<&Path>) -> PathBuf {
    if let Some(p) = arg {
        return p.to_path_buf();
    }
    if let Some(p) = std::env::var_os("GRANNY_DLL") {
        return PathBuf::from(p);
    }
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    exe_dir.unwrap_or_default().join("granny2_x64.dll")
}

impl Granny {
    pub fn load(path: &Path) -> Result<Granny> {
        if !path.is_file() {
            bail!(
                "{} not found. Pass --granny <granny2_x64.dll> or set GRANNY_DLL (Granny 2.11+ with the incremental BitKnit API).",
                path.display()
            );
        }
        unsafe {
            let lib = Library::new(path).with_context(|| format!("loading {}", path.display()))?;
            macro_rules! sym {
                ($name:literal) => {
                    *lib.get(concat!($name, "\0").as_bytes()).map_err(|e| anyhow!("{} missing from the DLL: {e}", $name))?
                };
            }
            let version_fn: unsafe extern "system" fn() -> *const c_char = sym!("GrannyGetVersionString");
            let version = CStr::from_ptr(version_fn()).to_string_lossy().into_owned();
            Ok(Granny {
                version,
                read_from_memory: sym!("GrannyReadEntireFileFromMemory"),
                free_file: sym!("GrannyFreeFile"),
                get_file_info: sym!("GrannyGetFileInfo"),
                begin_decompression: sym!("GrannyBeginFileDecompression"),
                decompress_incremental: sym!("GrannyDecompressIncremental"),
                end_decompression: sym!("GrannyEndFileDecompression"),
                decompress_data: sym!("GrannyDecompressData"),
                padding_size: sym!("GrannyGetCompressedBytesPaddingSize"),
                get_data_tree: sym!("GrannyGetDataTreeFromFile"),
                member_type_size: sym!("GrannyGetMemberTypeSize"),
                instantiate_model: sym!("GrannyInstantiateModel"),
                free_model_instance: sym!("GrannyFreeModelInstance"),
                play_controlled_animation: sym!("GrannyPlayControlledAnimation"),
                free_control: sym!("GrannyFreeControl"),
                set_model_clock: sym!("GrannySetModelClock"),
                new_local_pose: sym!("GrannyNewLocalPose"),
                free_local_pose: sym!("GrannyFreeLocalPose"),
                sample_model_animations: sym!("GrannySampleModelAnimations"),
                get_local_pose_transform: sym!("GrannyGetLocalPoseTransform"),
                _lib: lib,
            })
        }
    }

    pub fn open<'a>(&'a self, bytes: &'a [u8]) -> Option<File<'a>> {
        let f = unsafe { (self.read_from_memory)(bytes.len() as i32, bytes.as_ptr().cast()) };
        (!f.is_null()).then_some(File { g: self, ptr: f, _bytes: bytes })
    }

    /// Oodle1 (type 2) sections need the whole-buffer call with the section's 16/8-bit stops.
    pub fn decompress_whole(&self, kind: u32, comp: &[u8], stops: [u32; 3]) -> Result<Vec<u8>> {
        let pad = unsafe { (self.padding_size)(kind as i32) }.max(0) as usize;
        let mut input = comp.to_vec();
        input.resize(comp.len() + pad, 0);
        let mut out = vec![0u8; stops[2] as usize + 16];
        let ok = unsafe {
            (self.decompress_data)(
                kind as i32,
                0,
                comp.len() as i32,
                input.as_mut_ptr().cast(),
                stops[0] as i32,
                stops[1] as i32,
                stops[2] as i32,
                out.as_mut_ptr().cast(),
            )
        };
        if ok == 0 {
            bail!("GrannyDecompressData failed");
        }
        out.truncate(stops[2] as usize);
        Ok(out)
    }

    pub fn decompress(&self, kind: u32, comp: &[u8], size: usize) -> Result<Vec<u8>> {
        let mut out = vec![0u8; size + 16];
        let mut work = vec![0u8; 0x4000];
        unsafe {
            let state = (self.begin_decompression)(kind as i32, 0, size as i32, out.as_mut_ptr().cast(), 0x4000, work.as_mut_ptr().cast());
            if state.is_null() {
                bail!("GrannyBeginFileDecompression returned NULL");
            }
            let mut pos = 0;
            while pos < comp.len() {
                let chunk = (comp.len() - pos).min(0x2000);
                if (self.decompress_incremental)(state, chunk as i32, comp[pos..].as_ptr().cast()) == 0 {
                    bail!("DecompressIncremental failed at {pos}");
                }
                pos += chunk;
            }
            if (self.end_decompression)(state) == 0 {
                bail!("EndFileDecompression failed");
            }
        }
        out.truncate(size);
        Ok(out)
    }
}

pub struct File<'a> {
    g: &'a Granny,
    ptr: Ptr,
    _bytes: &'a [u8],
}

impl Drop for File<'_> {
    fn drop(&mut self) {
        unsafe { (self.g.free_file)(self.ptr) }
    }
}

impl<'a> File<'a> {
    pub fn info(&self) -> Option<&FileInfo> {
        unsafe { (self.g.get_file_info)(self.ptr).as_ref() }
    }

    pub fn data_tree(&self) -> Variant {
        let mut v = Variant { ty: std::ptr::null_mut(), object: std::ptr::null_mut() };
        unsafe { (self.g.get_data_tree)(self.ptr, &mut v) };
        v
    }
}

impl FileInfo {
    pub fn skeleton(&self) -> Option<&Skeleton> {
        let n = self.skeleton_count;
        let arr = self.skeletons;
        (n > 0).then(|| unsafe { &**arr })
    }
    pub fn model(&self) -> Option<*const Model> {
        let n = self.model_count;
        let arr = self.models;
        (n > 0).then(|| unsafe { *arr })
    }
    pub fn animation(&self) -> Option<*const Animation> {
        let n = self.animation_count;
        let arr = self.animations;
        (n > 0).then(|| unsafe { *arr })
    }
}

impl Skeleton {
    pub fn name_bytes(&self) -> Option<&[u8]> {
        cbytes(self.name)
    }
    pub fn bones(&self) -> &[Bone] {
        let n = self.bone_count.max(0) as usize;
        let p = self.bones;
        if n == 0 || p.is_null() { &[] } else { unsafe { std::slice::from_raw_parts(p, n) } }
    }
}

impl Bone {
    pub fn name_bytes(&self) -> Option<&[u8]> {
        cbytes(self.name)
    }
}

pub fn cbytes<'a>(p: *const c_char) -> Option<&'a [u8]> {
    (!p.is_null()).then(|| unsafe { CStr::from_ptr(p).to_bytes() })
}

pub fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

/// A model instance plus a local pose; one per worker.
pub struct Sampler<'a> {
    g: &'a Granny,
    instance: Ptr,
    pose: Ptr,
    pub bone_count: i32,
}

impl<'a> Sampler<'a> {
    pub fn new(g: &'a Granny, model: *const Model, bone_count: i32) -> Sampler<'a> {
        unsafe {
            Sampler { g, instance: (g.instantiate_model)(model), pose: (g.new_local_pose)(bone_count), bone_count }
        }
    }

    pub fn play(&self, anim: *const Animation) -> Ptr {
        unsafe { (self.g.play_controlled_animation)(0.0, anim, self.instance) }
    }

    pub fn free_control(&self, c: Ptr) {
        unsafe { (self.g.free_control)(c) }
    }

    pub fn sample(&self, t: f32) {
        unsafe {
            (self.g.set_model_clock)(self.instance, t);
            (self.g.sample_model_animations)(self.instance, 0, self.bone_count, self.pose);
        }
    }

    pub fn transform(&self, i: i32) -> Transform {
        unsafe { std::ptr::read_unaligned((self.g.get_local_pose_transform)(self.pose, i)) }
    }
}

impl Drop for Sampler<'_> {
    fn drop(&mut self) {
        unsafe {
            (self.g.free_model_instance)(self.instance);
            (self.g.free_local_pose)(self.pose);
        }
    }
}

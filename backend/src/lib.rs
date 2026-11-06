//! VRM avatar feature plugin backend (formerly the "library" plugin).
//!
//! Port of the former host module `src-tauri/src/plugins.rs` — the custom
//! avatar model / motion / emotion library (despite the file name, not the
//! plugin host) — plus the built-in demo model assets, which moved here from
//! the host's `public/model/` so the plugin fully owns its model data.
//!
//! - Storage: everything under `PluginCtx::data_dir()`, mirroring the
//!   original layout exactly: `motions/*.json`, `emotions/*.json`,
//!   `models/` (`.vrm`/`.glb` files) and `active_model.txt`.
//! - Assets: the built-in demo model (`demo.glb` + `demo-thumb.png`) lives in
//!   the plugin package's `assets/model/` dir (staged from
//!   `features/vrm/assets/model/` at build time), resolved via
//!   `PluginCtx::plugin_dir()` with a dev-checkout fallback. The webview has
//!   no file access to the package dir, so assets are served as base64
//!   through `vrm.load_builtin_model` / `vrm.model_thumbnail`.
//! - Methods: every former tauri command is reachable under a namespaced
//!   `vrm.*` method (legacy `library.*` and bare former command names route
//!   to the same handlers) with identical snake_case payload fields and
//!   result shapes.
//! - Events: the source module contained no `app.emit(...)` calls, so none
//!   are reproduced here (verified: no emits, and no other host module emits
//!   model-related events on its behalf).

use companion_plugin_sdk::{export_plugin, Plugin, PluginCtx};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

// ─── Motion metadata (verbatim from plugins.rs) ───

#[derive(Debug, Serialize, Deserialize)]
pub struct CustomMotionMeta {
    pub name: String,
    pub duration: f64,
    pub pose: serde_json::Value,
    #[serde(default, rename = "hipsPos", alias = "hips_pos")]
    pub hips_pos: Option<serde_json::Value>,
    #[serde(default, alias = "version")]
    pub version: Option<u64>,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CustomEmotionMeta {
    pub name: String,
    pub preset: String,
    #[serde(default = "default_reset_ms")]
    pub reset_ms: u64,
}

fn default_reset_ms() -> u64 {
    4000
}

fn sanitize_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

// ─── VRM model metadata ───

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelMeta {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub is_builtin: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MotionSummary {
    pub name: String,
    pub duration: f64,
    #[serde(default)]
    pub description: String,
}

const BUILTIN_MOTION_NAMES: &[&str] = &["none", "nod", "shake", "think"];

/// Motion bakes larger than this are listed (via cheap header scans) but
/// refused by `vrm.load_motion`: serde builds a full JSON DOM over the pose
/// payload, so a multi-minute clip (hundreds of MB on disk) costs seconds of
/// CPU and an order of magnitude of its file size in transient memory per
/// parse — enough to starve the whole app at startup. 64MB covers clips of
/// roughly three minutes.
const MOTION_LOAD_CAP: u64 = 64 * 1024 * 1024;

/// Cheaply extracted motion metadata (see `scan_motion_head`).
struct MotionHeadMeta {
    name: String,
    duration: f64,
    version: Option<u64>,
    description: String,
}

/// Extract name/duration/version/description from a motion JSON file without
/// building a DOM over the pose payload. `op_list_motions` used to
/// `serde_json::from_str` every file on every call: a full DOM over `pose`,
/// which for a long clip runs to hundreds of MB and seconds of CPU each time
/// — with two windows activating at once that starved the whole process and
/// wedged webview IPC. `serde_json::to_string_pretty` writes fields in
/// declaration order — name, duration, pose, hipsPos, version, description —
/// so name+duration sit in the first bytes and version+description in the
/// last ones; reading only the head and tail gets everything the list needs.
fn scan_motion_head(path: &Path, size: u64) -> MotionHeadMeta {
    const WINDOW: u64 = 8192;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let mut meta = MotionHeadMeta {
        name: stem.clone(),
        duration: 0.0,
        version: None,
        description: String::new(),
    };
    let Ok(mut file) = fs::File::open(path) else {
        return meta;
    };
    use std::io::{Read, Seek, SeekFrom};
    // Head window: the declaration order of the serialized struct puts
    // name+duration first.
    let head_len = size.min(WINDOW) as usize;
    let mut json = vec![0u8; head_len];
    if file.read_exact(&mut json).is_err() {
        return meta;
    }
    // Tail window: version+description are the last fields. Searched in the
    // head too, so small files (everything in one window) still match.
    if size > WINDOW {
        let tail_start = size - WINDOW;
        if file.seek(SeekFrom::Start(tail_start)).is_ok() {
            let mut tail = Vec::new();
            let _ = file.read_to_end(&mut tail);
            json.extend_from_slice(&tail);
        }
    }
    if let Some(n) = scan_string_field(&json, "name") {
        meta.name = n;
    }
    if let Some(d) = scan_f64_field(&json, "duration") {
        meta.duration = d;
    }
    if let Some(v) = scan_u64_field(&json, "version") {
        meta.version = Some(v);
    }
    if let Some(d) = scan_string_field(&json, "description") {
        meta.description = d;
    }
    meta
}

/// Value of `"key": "..."` in a (possibly partial) JSON document, handling
/// backslash escapes. `start` bounds the search to the head or tail region.
fn scan_string_field(json: &[u8], key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let pos = find_subslice(json, needle.as_bytes())?;
    let mut i = pos + needle.len();
    while i < json.len() && (json[i] as char).is_whitespace() {
        i += 1;
    }
    if i >= json.len() || json[i] != b':' {
        return None;
    }
    i += 1;
    while i < json.len() && (json[i] as char).is_whitespace() {
        i += 1;
    }
    if i >= json.len() || json[i] != b'"' {
        return None;
    }
    i += 1;
    let mut out = Vec::new();
    while i < json.len() {
        match json[i] {
            b'\\' if i + 1 < json.len() => {
                // Best-effort unescape for the escapes to_string_pretty emits.
                let esc = json[i + 1];
                out.push(match esc {
                    b'n' => b'\n',
                    b't' => b'\t',
                    b'r' => b'\r',
                    other => other,
                });
                i += 2;
            }
            b'"' => return String::from_utf8(out).ok(),
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    None
}

fn scan_f64_field(json: &[u8], key: &str) -> Option<f64> {
    let needle = format!("\"{key}\"");
    let pos = find_subslice(json, needle.as_bytes())?;
    let mut i = pos + needle.len();
    while i < json.len() && (json[i] as char).is_whitespace() {
        i += 1;
    }
    if i >= json.len() || json[i] != b':' {
        return None;
    }
    i += 1;
    while i < json.len() && (json[i] as char).is_whitespace() {
        i += 1;
    }
    let start = i;
    while i < json.len() && (json[i].is_ascii_digit() || matches!(json[i], b'.' | b'-' | b'+' | b'e' | b'E')) {
        i += 1;
    }
    std::str::from_utf8(&json[start..i]).ok()?.parse().ok()
}

fn scan_u64_field(json: &[u8], key: &str) -> Option<u64> {
    let needle = format!("\"{key}\"");
    let pos = find_subslice(json, needle.as_bytes())?;
    let mut i = pos + needle.len();
    while i < json.len() && (json[i] as char).is_whitespace() {
        i += 1;
    }
    if i >= json.len() || json[i] != b':' {
        return None;
    }
    i += 1;
    while i < json.len() && (json[i] as char).is_whitespace() {
        i += 1;
    }
    let start = i;
    while i < json.len() && json[i].is_ascii_digit() {
        i += 1;
    }
    std::str::from_utf8(&json[start..i]).ok()?.parse().ok()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The library: same directory layout and file formats as the former host
/// commands, rooted at the data dir the host provides. `plugin_dir` (the
/// read-only package dir) is where the built-in demo model assets live.
struct Library {
    data_dir: PathBuf,
    plugin_dir: Option<PathBuf>,
}

impl Library {
    fn data_root(&self) -> Result<PathBuf, String> {
        fs::create_dir_all(&self.data_dir).map_err(|e| format!("create dir: {e}"))?;
        Ok(self.data_dir.clone())
    }

    fn motions_dir(&self) -> Result<PathBuf, String> {
        let dir = self.data_root()?.join("motions");
        fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
        Ok(dir)
    }

    fn emotions_dir(&self) -> Result<PathBuf, String> {
        let dir = self.data_root()?.join("emotions");
        fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
        Ok(dir)
    }

    fn models_dir(&self) -> Result<PathBuf, String> {
        let dir = self.data_root()?.join("models");
        fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
        Ok(dir)
    }

    fn active_model_file(&self) -> Result<PathBuf, String> {
        Ok(self.data_root()?.join("active_model.txt"))
    }

    // ─── Built-in demo assets (moved here from the host's public/model/) ───

    /// Directory holding the built-in demo model assets (`demo.glb`,
    /// `demo-thumb.png`). Resolution mirrors the voice plugin's asset lookup:
    /// the staged package `assets/model/` first, then the dev-checkout source
    /// tree so tests and unbuilt checkouts still find the files.
    fn assets_model_dir(&self) -> Option<PathBuf> {
        if let Some(plugin_dir) = &self.plugin_dir {
            let staged = plugin_dir.join("assets").join("model");
            if staged.is_dir() {
                return Some(staged);
            }
        }
        // Dev fallback: features/vrm/assets/model (CARGO_MANIFEST_DIR is
        // features/vrm/backend).
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("assets")
            .join("model");
        if dev.is_dir() {
            return Some(dev);
        }
        None
    }

    /// Base64 of the built-in demo model, served to the webview the same way
    /// custom models are (`op_load_model`): bare base64, no data: URI.
    fn op_load_builtin_model(&self) -> Result<String, String> {
        use base64::Engine;
        let dir = self
            .assets_model_dir()
            .ok_or("built-in demo model assets are missing from the plugin package")?;
        let bytes = fs::read(dir.join("demo.glb")).map_err(|e| format!("read demo model: {e}"))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    // ─── VRM Model operations (former tauri commands) ───

    fn op_list_models(&self) -> Result<Vec<ModelMeta>, String> {
        let mut list = vec![ModelMeta {
            id: "builtin:demo".into(),
            name: "Demo (Built-in)".into(),
            size: 0,
            is_builtin: true,
        }];

        let dir = self.models_dir()?;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if ext.eq_ignore_ascii_case("vrm") || ext.eq_ignore_ascii_case("glb") {
                        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        list.push(ModelMeta {
                            id: format!("custom:{stem}"),
                            name: stem.replace('_', " "),
                            size,
                            is_builtin: false,
                        });
                    }
                }
            }
        }
        Ok(list)
    }

    fn op_save_model(&self, name: String, data_base64: String) -> Result<ModelMeta, String> {
        use base64::Engine;
        let clean = sanitize_name(&name);
        if clean.is_empty() {
            return Err("Invalid model name".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&data_base64)
            .map_err(|e| format!("base64 decode: {e}"))?;
        let dir = self.models_dir()?;
        let filename = format!("{clean}.vrm");
        let path = dir.join(&filename);
        let size = bytes.len() as u64;
        fs::write(&path, bytes).map_err(|e| format!("write model: {e}"))?;
        Ok(ModelMeta {
            id: format!("custom:{clean}"),
            name: clean.replace('_', " "),
            size,
            is_builtin: false,
        })
    }

    fn op_load_model(&self, id: String) -> Result<String, String> {
        use base64::Engine;
        let stem = id.strip_prefix("custom:").unwrap_or(&id);
        let clean = sanitize_name(stem);
        let dir = self.models_dir()?;
        let mut target = dir.join(format!("{clean}.vrm"));
        if !target.exists() {
            target = dir.join(format!("{clean}.glb"));
        }
        if !target.exists() {
            return Err(format!("Model not found: {clean}"));
        }
        let bytes = fs::read(&target).map_err(|e| format!("read model: {e}"))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    fn op_get_active_model(&self) -> Result<Option<String>, String> {
        let path = self.active_model_file()?;
        match fs::read_to_string(&path) {
            Ok(s) => {
                let s = s.trim().to_string();
                Ok(if s.is_empty() { None } else { Some(s) })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("read active model: {e}")),
        }
    }

    fn op_set_active_model(&self, id: String) -> Result<(), String> {
        let path = self.active_model_file()?;
        fs::write(&path, id).map_err(|e| format!("write active model: {e}"))?;
        Ok(())
    }

    fn op_delete_model(&self, id: String) -> Result<(), String> {
        let stem = id.strip_prefix("custom:").unwrap_or(&id);
        let clean = sanitize_name(stem);
        let dir = self.models_dir()?;
        for ext in ["vrm", "glb"] {
            let p = dir.join(format!("{clean}.{ext}"));
            if p.exists() {
                fs::remove_file(&p).map_err(|e| format!("delete model: {e}"))?;
            }
        }
        Ok(())
    }

    fn op_model_thumbnail(&self, id: String) -> Result<Option<String>, String> {
        // Builtin ids (e.g. "builtin:demo") resolve to the staged demo thumb
        // in the plugin package assets; custom ids keep the GLB-embedded path.
        if let Some(stem) = id.strip_prefix("builtin:") {
            let clean = sanitize_name(stem);
            if clean.is_empty() {
                return Ok(None);
            }
            let Some(dir) = self.assets_model_dir() else {
                return Ok(None);
            };
            // Staged name convention: demo.glb <-> demo-thumb.png. A missing
            // file resolves to "no thumb" (frontend treats null as such).
            let bytes = match fs::read(dir.join(format!("{clean}-thumb.png"))) {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(format!("read thumbnail: {e}")),
            };
            // Only serve image bytes we can actually label; a wrong guess
            // would put garbage into an <img src>.
            let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
                "image/png"
            } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
                "image/jpeg"
            } else {
                return Ok(None);
            };
            use base64::Engine;
            return Ok(Some(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )));
        }
        let stem = id.strip_prefix("custom:").unwrap_or(&id);
        let clean = sanitize_name(stem);
        if clean.is_empty() {
            return Ok(None);
        }
        let dir = self.models_dir()?;
        let mut target = dir.join(format!("{clean}.vrm"));
        if !target.exists() {
            target = dir.join(format!("{clean}.glb"));
        }
        if !target.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&target).map_err(|e| format!("read model: {e}"))?;
        let Some(img) = extract_glb_thumbnail(&bytes) else {
            return Ok(None);
        };
        // Only serve image bytes we can actually label; a wrong guess would put
        // garbage into an <img src>.
        let mime = if img.starts_with(&[0x89, b'P', b'N', b'G']) {
            "image/png"
        } else if img.starts_with(&[0xFF, 0xD8, 0xFF]) {
            "image/jpeg"
        } else {
            return Ok(None);
        };
        use base64::Engine;
        Ok(Some(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(img)
        )))
    }

    // ─── Motion operations (former tauri commands) ───

    fn op_list_motion_summaries(&self) -> Result<Vec<MotionSummary>, String> {
        let dir = self.motions_dir()?;
        let mut result = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    let head = scan_motion_head(&path, size);
                    if !head.name.is_empty() {
                        result.push(MotionSummary {
                            name: head.name,
                            duration: head.duration,
                            description: head.description,
                        });
                    }
                }
            }
        }
        Ok(result)
    }

    fn op_update_motion_description(&self, name: String, description: String) -> Result<(), String> {
        let dir = self.motions_dir()?;
        let name = sanitize_name(&name);
        if name.is_empty() {
            return Err("Invalid motion name".into());
        }
        let path = dir.join(format!("{name}.json"));
        let data = fs::read_to_string(&path).map_err(|_| format!("Motion not found: {name}"))?;
        let mut v: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        let desc: String = description.chars().take(280).collect();
        v["description"] = serde_json::Value::String(desc.trim().to_string());
        let json = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| format!("write: {e}"))?;
        Ok(())
    }

    fn op_rename_motion(&self, old_name: String, new_name: String) -> Result<(), String> {
        let dir = self.motions_dir()?;
        let old = sanitize_name(&old_name);
        let new = sanitize_name(&new_name);
        if old.is_empty() || new.is_empty() {
            return Err("Invalid motion name".into());
        }
        if BUILTIN_MOTION_NAMES.contains(&new.as_str()) {
            return Err(format!("\"{new}\" is a built-in motion name"));
        }
        let old_path = dir.join(format!("{old}.json"));
        let new_path = dir.join(format!("{new}.json"));
        if !old_path.exists() {
            return Err(format!("Motion not found: {old}"));
        }
        if new_path.exists() {
            return Err(format!("Motion already exists: {new}"));
        }
        let data = fs::read_to_string(&old_path).map_err(|e| format!("read: {e}"))?;
        let mut v: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        v["name"] = serde_json::Value::String(new.clone());
        let json = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
        fs::write(&new_path, json).map_err(|e| format!("write: {e}"))?;
        fs::remove_file(&old_path).map_err(|e| format!("delete: {e}"))?;
        let edir = self.emotions_dir()?;
        if let Ok(entries) = fs::read_dir(&edir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let stem = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string();
                if stem == old || stem.starts_with(&format!("{old}_")) {
                    let suffix = &stem[old.len()..];
                    let new_stem = format!("{new}{suffix}");
                    let clean = sanitize_name(&new_stem);
                    if let Ok(data) = fs::read_to_string(&path) {
                        if let Ok(mut ev) = serde_json::from_str::<serde_json::Value>(&data) {
                            ev["name"] = serde_json::Value::String(clean.clone());
                            if let Ok(json) = serde_json::to_string_pretty(&ev) {
                                let _ = fs::write(edir.join(format!("{clean}.json")), json);
                            }
                        }
                    }
                    let _ = fs::remove_file(&path);
                }
            }
        }
        Ok(())
    }

    /// List motions via the cheap head/tail scan — the pose payload is NOT
    /// included (`pose: null`); full metas load per-motion through
    /// `op_load_motion`. See `scan_motion_head` for why the full parse had
    /// to go.
    fn op_list_motions(&self) -> Result<Vec<CustomMotionMeta>, String> {
        let dir = self.motions_dir()?;
        let mut result = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    let head = scan_motion_head(&path, size);
                    result.push(CustomMotionMeta {
                        name: head.name,
                        duration: head.duration,
                        pose: Value::Null,
                        hips_pos: None,
                        version: head.version,
                        description: head.description,
                    });
                }
            }
        }
        Ok(result)
    }

    /// Full motion meta (including the pose) for one motion. Refuses bakes
    /// over `MOTION_LOAD_CAP` — see the constant's doc comment.
    fn op_load_motion(&self, name: String) -> Result<CustomMotionMeta, String> {
        let clean = sanitize_name(&name);
        if clean.is_empty() {
            return Err("Invalid motion name".into());
        }
        let path = self.motions_dir()?.join(format!("{clean}.json"));
        if !path.exists() {
            return Err(format!("Motion not found: {clean}"));
        }
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if size > MOTION_LOAD_CAP {
            return Err(format!(
                "Motion bake too large to load ({} bytes); re-import a shorter .vrma clip",
                size
            ));
        }
        let data = fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
        serde_json::from_str::<CustomMotionMeta>(&data).map_err(|e| format!("bad meta: {e}"))
    }

    fn op_save_motion(&self, meta: CustomMotionMeta) -> Result<(), String> {
        let dir = self.motions_dir()?;
        let name = sanitize_name(&meta.name);
        if name.is_empty() {
            return Err("Invalid motion name".into());
        }
        let path = dir.join(format!("{name}.json"));
        let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| format!("write: {e}"))?;
        Ok(())
    }

    fn op_delete_motion(&self, name: String) -> Result<(), String> {
        let dir = self.motions_dir()?;
        let name = sanitize_name(&name);
        let path = dir.join(format!("{name}.json"));
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("delete: {e}"))?;
        }
        if let Ok(edir) = self.emotions_dir() {
            if let Ok(entries) = fs::read_dir(&edir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let stem = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or_default()
                        .to_string();
                    if stem == name || stem.starts_with(&format!("{name}_")) {
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
        Ok(())
    }

    // ─── Emotion operations (former tauri commands) ───

    fn op_list_emotions(&self) -> Result<Vec<CustomEmotionMeta>, String> {
        let dir = self.emotions_dir()?;
        let mut result = Vec::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    if let Ok(data) = fs::read_to_string(&path) {
                        if let Ok(meta) = serde_json::from_str::<CustomEmotionMeta>(&data) {
                            result.push(meta);
                        }
                    }
                }
            }
        }
        Ok(result)
    }

    fn op_save_emotion(&self, meta: CustomEmotionMeta) -> Result<(), String> {
        let dir = self.emotions_dir()?;
        let name = sanitize_name(&meta.name);
        if name.is_empty() {
            return Err("Invalid emotion name".into());
        }
        let path = dir.join(format!("{name}.json"));
        let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| format!("write: {e}"))?;
        Ok(())
    }

    fn op_delete_emotion(&self, name: String) -> Result<(), String> {
        let dir = self.emotions_dir()?;
        let name = sanitize_name(&name);
        let path = dir.join(format!("{name}.json"));
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("delete: {e}"))?;
        }
        Ok(())
    }

    // ─── Request routing ───

    /// Route one request. Methods are the namespaced `vrm.*` names; the
    /// legacy `library.*` names and the bare former tauri command names are
    /// aliases to the same handlers.
    fn route(&self, method: &str, payload: Value) -> Result<Value, String> {
        let arg = |key: &str| -> Result<String, String> {
            payload
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| format!("{key} is required"))
        };
        match method {
            // ── Motions ──
            "vrm.list_motions" | "library.list_motions" | "list_custom_motions" => {
                json_ok(self.op_list_motions()?)
            }
            "vrm.load_motion" | "library.load_motion" | "load_custom_motion" => {
                json_ok(self.op_load_motion(arg("name")?)?)
            }
            "vrm.list_motion_summaries" | "library.list_motion_summaries" | "list_motion_summaries" => {
                json_ok(self.op_list_motion_summaries()?)
            }
            "vrm.save_motion" | "library.save_motion" | "save_custom_motion" => {
                let meta: CustomMotionMeta = serde_json::from_value(
                    payload.get("meta").cloned().unwrap_or(Value::Null),
                )
                .map_err(|e| format!("bad meta: {e}"))?;
                self.op_save_motion(meta)?;
                Ok(Value::Null)
            }
            "vrm.delete_motion" | "library.delete_motion" | "delete_custom_motion" => {
                self.op_delete_motion(arg("name")?)?;
                Ok(Value::Null)
            }
            "vrm.update_motion_description" | "library.update_motion_description" | "update_motion_description" => {
                self.op_update_motion_description(arg("name")?, arg("description")?)?;
                Ok(Value::Null)
            }
            "vrm.rename_motion" | "library.rename_motion" | "rename_custom_motion" => {
                self.op_rename_motion(arg("old_name")?, arg("new_name")?)?;
                Ok(Value::Null)
            }

            // ── Emotions ──
            "vrm.list_emotions" | "library.list_emotions" | "list_custom_emotions" => {
                json_ok(self.op_list_emotions()?)
            }
            "vrm.save_emotion" | "library.save_emotion" | "save_custom_emotion" => {
                let meta: CustomEmotionMeta = serde_json::from_value(
                    payload.get("meta").cloned().unwrap_or(Value::Null),
                )
                .map_err(|e| format!("bad meta: {e}"))?;
                self.op_save_emotion(meta)?;
                Ok(Value::Null)
            }
            "vrm.delete_emotion" | "library.delete_emotion" | "delete_custom_emotion" => {
                self.op_delete_emotion(arg("name")?)?;
                Ok(Value::Null)
            }

            // ── Models ──
            "vrm.list_models" | "library.list_models" | "list_models" => json_ok(self.op_list_models()?),
            "vrm.save_model" | "library.save_model" | "save_custom_model" => {
                json_ok(self.op_save_model(arg("name")?, arg("data_base64")?)?)
            }
            "vrm.load_model" | "library.load_model" | "load_custom_model" => {
                json_ok(self.op_load_model(arg("id")?)?)
            }
            // Built-in demo model, served from the plugin package assets.
            "vrm.load_builtin_model" | "library.load_builtin_model" | "load_builtin_model" => {
                json_ok(self.op_load_builtin_model()?)
            }
            "vrm.delete_model" | "library.delete_model" | "delete_custom_model" => {
                self.op_delete_model(arg("id")?)?;
                Ok(Value::Null)
            }
            "vrm.model_thumbnail" | "library.model_thumbnail" | "get_model_thumbnail" => {
                json_ok(self.op_model_thumbnail(arg("id")?)?)
            }
            "vrm.get_active_model" | "library.get_active_model" | "get_active_model" => {
                json_ok(self.op_get_active_model()?)
            }
            "vrm.set_active_model" | "library.set_active_model" | "set_active_model" => {
                self.op_set_active_model(arg("id")?)?;
                Ok(Value::Null)
            }

            other => Err(format!("unknown method: {other}")),
        }
    }
}

/// Serialize a successful result into the JSON value the host returns.
fn json_ok<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

/// Extract the avatar image embedded in a GLB/VRM file's meta, if present.
///
/// Covers all three meta layouts seen in the wild: VRM 0.x `meta.thumbnail`
/// (an image index), VRM 0.x legacy `meta.texture` (a texture index, as
/// written by older UniGLTF exporters like the two bundled models), and
/// VRM 1.0 `VRMC_vrm.meta.thumbnailImage` (a texture index).
pub fn extract_glb_thumbnail(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 20 || &bytes[0..4] != b"glTF" {
        return None;
    }
    let mut json: &[u8] = &[];
    let mut bin: &[u8] = &[];
    let mut off = 12usize;
    while off + 8 <= bytes.len() {
        let chunk_len = u32::from_le_bytes(bytes[off..off + 4].try_into().ok()?) as usize;
        let chunk_type = &bytes[off + 4..off + 8];
        let start = off + 8;
        let end = start.checked_add(chunk_len)?;
        if end > bytes.len() {
            return None;
        }
        if chunk_type == b"JSON" {
            json = &bytes[start..end];
        } else if chunk_type == b"BIN\0" {
            bin = &bytes[start..end];
        }
        off = end;
    }
    let v: serde_json::Value = serde_json::from_slice(json).ok()?;
    let images = v.get("images")?.as_array()?;
    let textures = v.get("textures").and_then(|t| t.as_array());
    let views = v.get("bufferViews").and_then(|b| b.as_array());

    let texture_source = |ti: u64| -> Option<usize> {
        textures?
            .get(ti as usize)?
            .get("source")?
            .as_u64()
            .map(|i| i as usize)
    };

    let ext = v.get("extensions");
    let mut image_idx: Option<usize> = None;
    if let Some(meta) = ext.and_then(|e| e.get("VRMC_vrm")).and_then(|m| m.get("meta")) {
        if let Some(ti) = meta.get("thumbnailImage").and_then(|t| t.as_u64()) {
            image_idx = texture_source(ti);
        }
    }
    if image_idx.is_none() {
        if let Some(meta) = ext.and_then(|e| e.get("VRM")).and_then(|m| m.get("meta")) {
            if let Some(ii) = meta.get("thumbnail").and_then(|t| t.as_u64()) {
                image_idx = Some(ii as usize);
            } else if let Some(ti) = meta.get("texture").and_then(|t| t.as_u64()) {
                image_idx = texture_source(ti);
            }
        }
    }
    let image = images.get(image_idx?)?;

    // Images may also arrive as a data URI inside the JSON itself.
    if let Some(uri) = image.get("uri").and_then(|u| u.as_str()) {
        let payload = uri.strip_prefix("data:")?.split_once(',')?.1;
        use base64::Engine;
        return base64::engine::general_purpose::STANDARD.decode(payload).ok();
    }

    let view = views?.get(image.get("bufferView")?.as_u64()? as usize)?;
    let byte_offset = view.get("byteOffset").and_then(|b| b.as_u64()).unwrap_or(0) as usize;
    let byte_length = view.get("byteLength")?.as_u64()? as usize;
    bin.get(byte_offset..byte_offset.checked_add(byte_length)?)?
        .to_vec()
        .into()
}

// ---------------------------------------------------------------------------
// Plugin impl
// ---------------------------------------------------------------------------

/// Concrete plugin type handed to `export_plugin!`.
///
/// No events are emitted (the source module had none), so the
/// `PluginCtx` is only used during `init`; a data dir plus the package dir
/// (for the built-in demo assets) are the only state.
pub struct VrmPlugin {
    inner: Option<Library>,
}

impl Default for VrmPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl VrmPlugin {
    pub fn new() -> Self {
        VrmPlugin { inner: None }
    }
}

impl Plugin for VrmPlugin {
    fn init(&mut self, ctx: PluginCtx) -> Result<(), String> {
        let data_dir = ctx.data_dir().ok_or("host did not provide a data dir")?;
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let plugin_dir = ctx.plugin_dir();
        if plugin_dir.is_none() {
            ctx.warn("no plugin dir provided; built-in demo model assets unavailable");
        }
        ctx.info("vrm ready");
        self.inner = Some(Library { data_dir, plugin_dir });
        Ok(())
    }

    fn handle(&mut self, method: &str, payload: Value) -> Result<Value, String> {
        let library = self
            .inner
            .as_ref()
            .ok_or("vrm plugin failed to initialise")?;
        // Per-call timing on the host console: a slow or wedged call is the
        // first thing to rule out when a webview misbehaves, and plugin
        // webview consoles are not visible in production.
        let start = std::time::Instant::now();
        let result = library.route(method, payload);
        println!(
            "[vrm-backend] {method} in {:?} ok={}",
            start.elapsed(),
            result.is_ok()
        );
        result
    }
}

export_plugin!(VrmPlugin::new());

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use serde_json::json;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "library-plugin-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn library() -> Library {
        Library {
            data_dir: temp_root("dir"),
            plugin_dir: None,
        }
    }

    // ── sanitize_name (ported behavior) ──

    #[test]
    fn sanitize_name_keeps_only_word_characters() {
        assert_eq!(sanitize_name("a b/c.d_e-f"), "abcd_e-f");
        assert_eq!(sanitize_name("!!!"), "");
        // char::is_alphanumeric is Unicode-aware, so non-ASCII letters survive.
        assert_eq!(sanitize_name("café"), "café");
        assert_eq!(sanitize_name("波 01"), "波01");
        assert_eq!(sanitize_name("Aoi Chan!"), "AoiChan");
    }

    // ── Ported from plugins.rs ──
    // The GLB thumbnail parsing is covered by synthetic glb bytes; the real
    // bundled demo.glb is served by the builtin ops below from the plugin's
    // own staged assets.

    #[test]
    fn rejects_non_glb_bytes() {
        assert!(extract_glb_thumbnail(b"not a glb file").is_none());
        assert!(extract_glb_thumbnail(&[]).is_none());
    }

    fn chunk(chunk_type: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut c = (data.len() as u32).to_le_bytes().to_vec();
        c.extend_from_slice(chunk_type);
        c.extend_from_slice(data);
        c
    }

    fn padded(data: &[u8], filler: u8) -> Vec<u8> {
        let mut d = data.to_vec();
        while d.len() % 4 != 0 {
            d.push(filler);
        }
        d
    }

    fn minimal_glb(json: &serde_json::Value, bin: &[u8]) -> Vec<u8> {
        let json_chunk = padded(json.to_string().as_bytes(), b' ');
        let bin_chunk = padded(bin, 0);
        let mut glb = Vec::new();
        glb.extend_from_slice(b"glTF");
        glb.extend_from_slice(&2u32.to_le_bytes());
        glb.extend_from_slice(
            &((12 + json_chunk.len() + bin_chunk.len()) as u32).to_le_bytes(),
        );
        glb.extend_from_slice(&chunk(b"JSON", &json_chunk));
        glb.extend_from_slice(&chunk(b"BIN\0", &bin_chunk));
        glb
    }

    #[test]
    fn extracts_thumbnail_via_vrm0_texture_index_and_buffer_view() {
        let png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let glb = minimal_glb(
            &json!({
                "images": [{ "bufferView": 0, "mimeType": "image/png" }],
                "textures": [{ "source": 0 }],
                "bufferViews": [{ "byteOffset": 0, "byteLength": png.len() }],
                "extensions": { "VRM": { "meta": { "texture": 0 } } },
            }),
            &png,
        );
        let img = extract_glb_thumbnail(&glb).expect("thumbnail from buffer view");
        assert_eq!(img, png);
    }

    #[test]
    fn extracts_thumbnail_from_data_uri() {
        let bytes = vec![0x89, b'P', b'N', b'G'];
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let glb = minimal_glb(
            &json!({
                "images": [{ "uri": format!("data:image/png;base64,{b64}") }],
                "textures": [{ "source": 0 }],
                "extensions": { "VRMC_vrm": { "meta": { "thumbnailImage": 0 } } },
            }),
            &[],
        );
        let img = extract_glb_thumbnail(&glb).expect("thumbnail from data uri");
        assert_eq!(img, bytes);
    }

    // ── Motions: save / list / update / rename / delete roundtrip ──

    #[test]
    fn motion_save_list_update_delete_roundtrip() {
        let lib = library();
        let meta = json!({
            "name": "Wave!!",
            "duration": 1.5,
            "pose": { "keys": [0.1, 0.2] },
            "hipsPos": [0.0, 1.0, 0.0],
            "description": "waves hello"
        });
        lib.route("library.save_motion", json!({ "meta": meta })).unwrap();
        // File uses the sanitized name; the stored JSON keeps meta as sent.
        let motions = lib.motions_dir().unwrap();
        assert!(motions.join("Wave.json").exists());

        // list_motions is a cheap scan: meta fields come through, the pose
        // payload does not (it loads per-motion via load_motion).
        let listed: Vec<CustomMotionMeta> =
            serde_json::from_value(lib.route("library.list_motions", json!({})).unwrap()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Wave!!");
        assert_eq!(listed[0].duration, 1.5);
        assert_eq!(listed[0].description, "waves hello");
        assert!(listed[0].pose.is_null());
        assert_eq!(listed[0].hips_pos, None);
        assert_eq!(listed[0].version, None);

        let summaries: Vec<MotionSummary> = serde_json::from_value(
            lib.route("library.list_motion_summaries", json!({})).unwrap(),
        )
        .unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].name, "Wave!!");
        assert_eq!(summaries[0].duration, 1.5);
        assert_eq!(summaries[0].description, "waves hello");

        lib.route(
            "library.update_motion_description",
            json!({ "name": "Wave!!", "description": "  a much longer story  " }),
        )
        .unwrap();
        let summaries: Vec<MotionSummary> = serde_json::from_value(
            lib.route("library.list_motion_summaries", json!({})).unwrap(),
        )
        .unwrap();
        assert_eq!(summaries[0].description, "a much longer story");

        lib.route("library.delete_motion", json!({ "name": "Wave!!" }))
            .unwrap();
        assert!(!motions.join("Wave.json").exists());
        assert!(
            lib.route("library.list_motions", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn motion_save_rejects_invalid_names() {
        let lib = library();
        let err = lib
            .route(
                "library.save_motion",
                json!({ "meta": json!({ "name": "!!!", "duration": 1.0, "pose": null }) }),
            )
            .unwrap_err();
        assert_eq!(err, "Invalid motion name");
    }

    // ── Motion head/tail scan (the giant-bake protection) ──

    /// A motion JSON whose pose payload is far bigger than the scan windows.
    fn giant_motion_json(padding_kb: usize) -> String {
        let mut s = String::from(
            "{\n  \"name\": \"Reading (Loop)\",\n  \"duration\": 757.5,\n  \"pose\": { \"chest\": [",
        );
        // 1KB of filler per unit keeps the test file size predictable.
        let unit = format!("{:?}", vec![0.12345678f64; 20]);
        for _ in 0..padding_kb {
            s.push_str(&unit);
            s.push(',');
        }
        s.push_str("]},\n  \"version\": 3,\n  \"description\": \"Reading (Loop) custom motion clip\"\n}");
        s
    }

    #[test]
    fn motion_scan_reads_head_and_tail_without_the_pose() {
        let lib = library();
        let dir = lib.motions_dir().unwrap();
        let big = dir.join("Giant.json");
        fs::write(&big, giant_motion_json(2048)).unwrap(); // ~2MB, both windows matter
        let size = fs::metadata(&big).unwrap().len();
        assert!(size > 8192, "test file must span head and tail windows");

        let head = scan_motion_head(&big, size);
        assert_eq!(head.name, "Reading (Loop)");
        assert!((head.duration - 757.5).abs() < f64::EPSILON);
        assert_eq!(head.version, Some(3));
        assert_eq!(head.description, "Reading (Loop) custom motion clip");

        let listed: Vec<CustomMotionMeta> =
            serde_json::from_value(lib.route("vrm.list_motions", json!({})).unwrap()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Reading (Loop)");
        assert_eq!(listed[0].version, Some(3));
        assert!(listed[0].pose.is_null());

        let summaries: Vec<MotionSummary> = serde_json::from_value(
            lib.route("vrm.list_motion_summaries", json!({})).unwrap(),
        )
        .unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].name, "Reading (Loop)");
    }

    #[test]
    fn load_motion_returns_full_meta_and_caps_size() {
        let lib = library();
        lib.route(
            "library.save_motion",
            json!({ "meta": json!({
                "name": "Wave",
                "duration": 2.0,
                "pose": { "head": [{ "t": 0.0 }] },
                "hipsPos": [0.0, 1.0, 0.0],
                "version": 3,
                "description": "d"
            }) }),
        )
        .unwrap();
        let full: CustomMotionMeta = serde_json::from_value(
            lib.route("vrm.load_motion", json!({ "name": "Wave" })).unwrap(),
        )
        .unwrap();
        assert_eq!(full.name, "Wave");
        assert_eq!(full.pose, json!({ "head": [{ "t": 0.0 }] }));
        assert_eq!(full.hips_pos, Some(json!([0.0, 1.0, 0.0])));

        // Oversized bake: listed fine (cheap scan), refused by load. Written
        // in appended chunks — the JSON only needs the head fields to be
        // parseable by the scan, not valid overall.
        let dir = lib.motions_dir().unwrap();
        let big = dir.join("Huge.json");
        use std::io::Write;
        let mut f = fs::File::create(&big).unwrap();
        write!(
            f,
            "{{\n  \"name\": \"Huge\",\n  \"duration\": 1.0,\n  \"pose\": ["
        )
        .unwrap();
        let chunk = vec![b'x'; 65536];
        while f.metadata().unwrap().len() <= MOTION_LOAD_CAP {
            f.write_all(&chunk).unwrap();
        }
        drop(f);
        let listed: Vec<CustomMotionMeta> =
            serde_json::from_value(lib.route("vrm.list_motions", json!({})).unwrap()).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(
            listed.iter().any(|m| m.name == "Huge"),
            "oversized bake must still be listed (read_dir order varies)"
        );
        let err = lib
            .route("vrm.load_motion", json!({ "name": "Huge" }))
            .unwrap_err();
        assert!(err.contains("too large"), "unexpected error: {err}");
    }

    #[test]
    fn motion_delete_cascades_to_matching_emotions() {
        let lib = library();
        lib.route(
            "library.save_motion",
            json!({ "meta": json!({ "name": "Wave", "duration": 1.0, "pose": {} }) }),
        )
        .unwrap();
        for emotion in ["Wave", "Wave_hand", "Other"] {
            lib.route(
                "library.save_emotion",
                json!({ "meta": json!({ "name": emotion, "preset": "joy" }) }),
            )
            .unwrap();
        }
        lib.route("library.delete_motion", json!({ "name": "Wave" }))
            .unwrap();
        let emotions = lib.emotions_dir().unwrap();
        assert!(!emotions.join("Wave.json").exists());
        assert!(!emotions.join("Wave_hand.json").exists());
        assert!(emotions.join("Other.json").exists());
    }

    #[test]
    fn rename_motion_moves_file_and_matching_emotions() {
        let lib = library();
        lib.route(
            "library.save_motion",
            json!({ "meta": json!({ "name": "Wave", "duration": 1.0, "pose": {} }) }),
        )
        .unwrap();
        lib.route(
            "library.save_emotion",
            json!({ "meta": json!({ "name": "Wave_hand", "preset": "joy" }) }),
        )
        .unwrap();
        lib.route(
            "library.rename_motion",
            json!({ "old_name": "Wave", "new_name": "Bow" }),
        )
        .unwrap();
        let motions = lib.motions_dir().unwrap();
        assert!(motions.join("Bow.json").exists());
        assert!(!motions.join("Wave.json").exists());
        let emotions = lib.emotions_dir().unwrap();
        assert!(emotions.join("Bow_hand.json").exists());
        assert!(!emotions.join("Wave_hand.json").exists());
        // Built-in motion names are reserved.
        assert!(
            lib.route(
                "library.rename_motion",
                json!({ "old_name": "Bow", "new_name": "nod" })
            )
            .is_err()
        );
    }

    // ── Emotions: save / list / delete roundtrip ──

    #[test]
    fn emotion_save_list_delete_roundtrip() {
        let lib = library();
        // reset_ms defaults to 4000 when omitted.
        lib.route(
            "library.save_emotion",
            json!({ "meta": json!({ "name": "Smile", "preset": "happy" }) }),
        )
        .unwrap();
        let listed: Vec<CustomEmotionMeta> = serde_json::from_value(
            lib.route("library.list_emotions", json!({})).unwrap(),
        )
        .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Smile");
        assert_eq!(listed[0].preset, "happy");
        assert_eq!(listed[0].reset_ms, 4000);
        lib.route("library.delete_emotion", json!({ "name": "Smile" }))
            .unwrap();
        assert!(!lib.emotions_dir().unwrap().join("Smile.json").exists());
    }

    // ── Models: save / list / load / thumbnail / delete + active model ──

    #[test]
    fn model_save_list_load_delete_and_active_model_roundtrip() {
        let lib = library();
        let bytes = b"fake-vrm-bytes".to_vec();
        let data_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

        let meta = lib
            .route(
                "library.save_model",
                json!({ "name": "Aoi Chan", "data_base64": data_base64 }),
            )
            .unwrap();
        // The space is sanitized away for the id/file, matching plugins.rs.
        assert_eq!(meta["id"], "custom:AoiChan");
        assert_eq!(meta["name"], "AoiChan");
        assert_eq!(meta["size"], bytes.len() as u64);
        assert!(!meta["is_builtin"].as_bool().unwrap());
        let models = lib.models_dir().unwrap();
        assert!(models.join("AoiChan.vrm").exists());

        let list = lib.route("library.list_models", json!({})).unwrap();
        let list = list.as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["id"], "builtin:demo");
        assert!(list[0]["is_builtin"].as_bool().unwrap());
        assert_eq!(list[1]["id"], "custom:AoiChan");

        let loaded = lib
            .route("library.load_model", json!({ "id": "custom:AoiChan" }))
            .unwrap();
        let decoded =
            base64::engine::general_purpose::STANDARD.decode(loaded.as_str().unwrap()).unwrap();
        assert_eq!(decoded, bytes);

        // Fake bytes carry no embedded image; the thumbnail must be null.
        assert_eq!(
            lib.route("library.model_thumbnail", json!({ "id": "custom:AoiChan" }))
                .unwrap(),
            Value::Null
        );

        lib.route(
            "library.set_active_model",
            json!({ "id": "custom:AoiChan" }),
        )
        .unwrap();
        assert_eq!(
            lib.route("library.get_active_model", json!({})).unwrap(),
            json!("custom:AoiChan")
        );
        // The pointer file lives directly in the data dir.
        assert!(lib.data_root().unwrap().join("active_model.txt").exists());
        // Legacy alias reaches the same handler.
        assert_eq!(
            lib.route("get_active_model", json!({})).unwrap(),
            json!("custom:AoiChan")
        );

        lib.route(
            "library.delete_model",
            json!({ "id": "custom:AoiChan" }),
        )
        .unwrap();
        assert!(!models.join("Aoi_Chan.vrm").exists());
        assert!(
            lib.route("load_custom_model", json!({ "id": "custom:AoiChan" }))
                .is_err()
        );

        // Empty sanitized names are rejected; unknown ids error cleanly.
        assert!(
            lib.route(
                "library.save_model",
                json!({ "name": "!!!", "data_base64": "" })
            )
            .is_err()
        );
        assert!(
            lib.route("library.load_model", json!({ "id": "custom:missing" }))
                .is_err()
        );
    }

    // ── Legacy command-name aliases ──

    #[test]
    fn legacy_command_names_route_to_the_same_handlers() {
        let lib = library();
        lib.route(
            "save_custom_motion",
            json!({ "meta": json!({ "name": "Wave", "duration": 2.0, "pose": {} }) }),
        )
        .unwrap();
        assert_eq!(
            lib.route("list_custom_motions", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            lib.route("list_motion_summaries", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        lib.route(
            "update_motion_description",
            json!({ "name": "Wave", "description": "d" }),
        )
        .unwrap();
        lib.route(
            "save_custom_emotion",
            json!({ "meta": json!({ "name": "Wave_up", "preset": "joy" }) }),
        )
        .unwrap();
        assert_eq!(
            lib.route("list_custom_emotions", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        lib.route("delete_custom_emotion", json!({ "name": "Wave_up" }))
            .unwrap();
        lib.route("delete_custom_motion", json!({ "name": "Wave" }))
            .unwrap();
        assert!(
            lib.route("list_custom_motions", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
        // Unknown methods still error.
        assert!(lib.route("library.nope", json!({})).is_err());
        assert!(lib.route("vrm.nope", json!({})).is_err());
    }

    // ── Built-in demo assets served from the plugin package ──

    /// A Library whose package dir has staged `assets/model/` files.
    fn library_with_assets(files: &[(&str, &[u8])]) -> Library {
        let plugin_dir = temp_root("pkg");
        let assets = plugin_dir.join("assets").join("model");
        std::fs::create_dir_all(&assets).unwrap();
        for (name, bytes) in files {
            std::fs::write(assets.join(name), bytes).unwrap();
        }
        Library {
            data_dir: temp_root("dir"),
            plugin_dir: Some(plugin_dir),
        }
    }

    #[test]
    fn builtin_model_serves_staged_assets_as_base64() {
        let bytes = b"fake-demo-glb-bytes".to_vec();
        let lib = library_with_assets(&[("demo.glb", &bytes)]);
        let loaded = lib.route("vrm.load_builtin_model", json!({})).unwrap();
        let decoded =
            base64::engine::general_purpose::STANDARD.decode(loaded.as_str().unwrap()).unwrap();
        assert_eq!(decoded, bytes);
        // Legacy namespaced alias reaches the same handler.
        let alias = lib.route("library.load_builtin_model", json!({})).unwrap();
        assert_eq!(alias, loaded);
    }

    #[test]
    fn builtin_thumbnail_serves_staged_png_as_data_uri() {
        let png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let lib = library_with_assets(&[("demo-thumb.png", &png)]);
        let thumb = lib
            .route("vrm.model_thumbnail", json!({ "id": "builtin:demo" }))
            .unwrap();
        assert_eq!(
            thumb,
            json!(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&png)
            ))
        );
        // Unknown builtin ids resolve to nothing rather than erroring.
        assert_eq!(
            lib.route("vrm.model_thumbnail", json!({ "id": "builtin:missing" }))
                .unwrap(),
            Value::Null
        );
    }

    #[test]
    fn builtin_model_falls_back_to_dev_checkout_assets() {
        // With no plugin dir the resolver falls back to the dev-checkout
        // source tree (features/vrm/assets/model), so a fresh checkout serves
        // the real demo model without a build step.
        let lib = library();
        let loaded = lib.route("vrm.load_builtin_model", json!({})).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(loaded.as_str().unwrap())
            .unwrap();
        assert_eq!(&decoded[0..4], b"glTF", "dev fallback must serve the real demo.glb");
        // The real file's embedded thumb is pre-extracted next to it; the
        // builtin thumbnail route serves it as a data URI.
        let thumb = lib
            .route("vrm.model_thumbnail", json!({ "id": "builtin:demo" }))
            .unwrap();
        assert!(
            thumb.as_str().unwrap().starts_with("data:image/png;base64,"),
            "builtin thumb must be a png data uri"
        );
        // Unknown builtin ids resolve to nothing rather than erroring.
        assert_eq!(
            lib.route("vrm.model_thumbnail", json!({ "id": "builtin:missing" }))
                .unwrap(),
            Value::Null
        );
    }

    #[test]
    fn vrm_namespaced_aliases_route_like_library_ones() {
        let lib = library();
        lib.route(
            "vrm.save_motion",
            json!({ "meta": json!({ "name": "Wave", "duration": 2.0, "pose": {} }) }),
        )
        .unwrap();
        let listed = lib.route("vrm.list_motions", json!({})).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        lib.route("vrm.set_active_model", json!({ "id": "builtin:demo" }))
            .unwrap();
        assert_eq!(
            lib.route("vrm.get_active_model", json!({})).unwrap(),
            json!("builtin:demo")
        );
    }
}

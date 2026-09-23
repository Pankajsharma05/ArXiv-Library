// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Pankaj Sharma. See LICENSE.

//! Source figures: downloads a paper's LaTeX source bundle from arXiv, keeps
//! only the image files, and reads the .tex to number and caption them.
//!
//! Fetched figures live in a temp cache until the user keeps them, which moves
//! the folder into the library (`<data>/Figures/<id>/`). Each folder holds the
//! images plus a `manifest.json` describing them.
//!
//! The bundle is untrusted input: sizes are capped, archive paths are never
//! used to build output paths, and only image files are written.

use crate::db::data_dir;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};

const MAX_DOWNLOAD: u64 = 300 * 1024 * 1024;
/// Guards against decompression bombs: stop reading after this many bytes.
const MAX_UNPACKED: u64 = 1024 * 1024 * 1024;
const MAX_IMAGE: u64 = 100 * 1024 * 1024;
const MAX_ALL_IMAGES: u64 = 500 * 1024 * 1024;
const MAX_TEX: u64 = 8 * 1024 * 1024;
/// In preference order, used when \includegraphics omits the extension.
const IMAGE_EXTS: &[&str] = &["pdf", "png", "jpg", "jpeg", "eps", "ps", "svg", "gif"];
const FIGURE_ENVS: &[&str] = &["figure", "figure*", "wrapfigure", "SCfigure", "sidewaysfigure"];
const MANIFEST: &str = "manifest.json";
const NO_SOURCE: &str = "arXiv has no LaTeX source for this paper (it was submitted as a PDF only).";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Figure {
    /// Figure number as LaTeX would print it; None for uncaptioned floats and
    /// images the text never includes.
    pub number: Option<u32>,
    /// Sub-panel letter when one figure includes several images.
    pub part: Option<String>,
    pub caption: String,
    /// File name inside the figure folder; None for figures with no image file.
    pub file: Option<String>,
    /// Path inside the source bundle.
    pub source: Option<String>,
    /// Image extension, "code" (drawn in TikZ etc.) or "missing" (image not in the bundle).
    pub kind: String,
    pub bytes: u64,
    #[serde(default, skip_deserializing)]
    pub path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FigureSet {
    pub arxiv_id: String,
    pub figures: Vec<Figure>,
    #[serde(default, skip_deserializing)]
    pub dir: String,
    #[serde(default, skip_deserializing)]
    pub in_library: bool,
}

// ---------- Folders ----------

fn safe_id(arxiv_id: &str) -> String {
    arxiv_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect()
}

fn library_root() -> PathBuf {
    data_dir().join("Figures")
}

fn cache_root() -> PathBuf {
    std::env::temp_dir().join("arxiv_library_figures")
}

fn load(dir: &Path, in_library: bool) -> Option<FigureSet> {
    let raw = std::fs::read_to_string(dir.join(MANIFEST)).ok()?;
    let mut set: FigureSet = serde_json::from_str(&raw).ok()?;
    set.dir = dir.to_string_lossy().to_string();
    set.in_library = in_library;
    for f in &mut set.figures {
        f.path = f
            .file
            .as_ref()
            .map(|name| dir.join(name))
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().to_string());
    }
    Some(set)
}

/// Previously fetched figures for a paper: the library copy, else the temp cache.
pub fn cached(arxiv_id: &str) -> Option<FigureSet> {
    let id = safe_id(arxiv_id);
    load(&library_root().join(&id), true).or_else(|| load(&cache_root().join(&id), false))
}

/// Moves a folder, falling back to copy + delete when the two locations are on
/// different filesystems (the temp dir often is). Figure folders are flat.
fn move_dir(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create folder: {e}"))?;
    }
    std::fs::remove_dir_all(to).ok();
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::create_dir_all(to).map_err(|e| format!("Could not create folder: {e}"))?;
    for entry in std::fs::read_dir(from).map_err(|e| format!("Could not read folder: {e}"))? {
        let entry = entry.map_err(|e| format!("Could not read folder: {e}"))?;
        std::fs::copy(entry.path(), to.join(entry.file_name()))
            .map_err(|e| format!("Could not copy figure: {e}"))?;
    }
    std::fs::remove_dir_all(from).ok();
    Ok(())
}

/// Moves fetched figures into the library so they survive temp cleanup.
pub fn keep_in_library(arxiv_id: &str) -> Result<FigureSet, String> {
    let id = safe_id(arxiv_id);
    let lib = library_root().join(&id);
    if let Some(set) = load(&lib, true) {
        return Ok(set);
    }
    let cache = cache_root().join(&id);
    if load(&cache, false).is_none() {
        return Err("Fetch the figures first".into());
    }
    move_dir(&cache, &lib)?;
    load(&lib, true).ok_or_else(|| "Could not keep figures".into())
}

/// Moves a paper's figures out of the library back into the temp cache, so the
/// open figure panel keeps working until the cache is cleaned.
pub fn remove_from_library(arxiv_id: &str) -> Result<(), String> {
    let id = safe_id(arxiv_id);
    let lib = library_root().join(&id);
    if lib.exists() {
        move_dir(&lib, &cache_root().join(&id)).or_else(|_| {
            std::fs::remove_dir_all(&lib).map_err(|e| format!("Could not delete figures: {e}"))
        })?;
    }
    Ok(())
}

/// Copies figures into `~/Downloads/<id>_figures/`, prefixing each file with its
/// figure number. `files` limits the copy to those file names. Returns the
/// folder path and how many files were written.
pub fn save_to_downloads(arxiv_id: &str, files: Option<Vec<String>>) -> Result<(String, u32), String> {
    let set = cached(arxiv_id).ok_or("Fetch the figures first")?;
    let downloads = dirs::download_dir().ok_or("Could not locate the Downloads folder")?;
    let dest_dir = downloads.join(format!("{}_figures", safe_id(arxiv_id)));
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("Could not create folder: {e}"))?;
    let wanted: Option<HashSet<String>> = files.map(|v| v.into_iter().collect());
    let mut count = 0;
    for f in &set.figures {
        let (Some(file), Some(path)) = (&f.file, &f.path) else { continue };
        if wanted.as_ref().is_some_and(|w| !w.contains(file)) {
            continue;
        }
        std::fs::copy(path, dest_dir.join(download_name(f, file)))
            .map_err(|e| format!("Could not copy to Downloads: {e}"))?;
        count += 1;
    }
    Ok((dest_dir.to_string_lossy().to_string(), count))
}

fn download_name(f: &Figure, file: &str) -> String {
    match (f.number, &f.part) {
        (Some(n), Some(p)) => format!("Fig{n:02}{p}_{file}"),
        (Some(n), None) => format!("Fig{n:02}_{file}"),
        _ => format!("Other_{file}"),
    }
}

/// Bytes used by figures kept in the library.
pub fn storage_used() -> u64 {
    let Ok(dirs) = std::fs::read_dir(library_root()) else { return 0 };
    dirs.flatten()
        .filter_map(|d| std::fs::read_dir(d.path()).ok())
        .flat_map(|files| files.flatten())
        .filter_map(|f| f.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Deletes every kept figure folder; returns how many papers had figures.
pub fn delete_all() -> u32 {
    let Ok(dirs) = std::fs::read_dir(library_root()) else { return 0 };
    dirs.flatten()
        .filter(|d| std::fs::remove_dir_all(d.path()).is_ok())
        .count() as u32
}

/// Deletes kept figures whose paper is no longer in the library.
pub fn prune(library_ids: &[String]) {
    let keep: HashSet<String> = library_ids.iter().map(|id| safe_id(id)).collect();
    let Ok(dirs) = std::fs::read_dir(library_root()) else { return };
    for d in dirs.flatten() {
        if !keep.contains(&d.file_name().to_string_lossy().to_string()) {
            std::fs::remove_dir_all(d.path()).ok();
        }
    }
}

/// Reads a figure for preview. Only files inside a figure folder are allowed,
/// since the path comes from the webview.
pub fn read(path: &str) -> Result<Vec<u8>, String> {
    let file = std::fs::canonicalize(path).map_err(|e| format!("Could not read figure: {e}"))?;
    let allowed = [library_root(), cache_root()]
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .any(|root| file.starts_with(root));
    if !allowed {
        return Err("Not a figure file".into());
    }
    std::fs::read(&file).map_err(|e| format!("Could not read figure: {e}"))
}

/// Drops temp-cache entries older than a week.
fn prune_cache() {
    let Ok(entries) = std::fs::read_dir(cache_root()) else { return };
    let cutoff = SystemTime::now() - Duration::from_secs(7 * 24 * 3600);
    for e in entries.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).map(|t| t < cutoff).unwrap_or(false);
        if old {
            let p = e.path();
            if p.is_dir() { std::fs::remove_dir_all(p).ok(); } else { std::fs::remove_file(p).ok(); }
        }
    }
}

// ---------- Fetch ----------

/// Returns the paper's figures, downloading and extracting its source unless a
/// cached copy exists. Progress is emitted as "download-progress" events tagged
/// with `figures:<arxiv_id>`.
pub async fn fetch(arxiv_id: &str, app: Option<&AppHandle>) -> Result<FigureSet, String> {
    if let Some(set) = cached(arxiv_id) {
        return Ok(set);
    }
    prune_cache();
    let root = cache_root();
    std::fs::create_dir_all(&root).map_err(|e| format!("Could not create cache folder: {e}"))?;
    let id = safe_id(arxiv_id);
    let archive = root.join(format!("{id}.src.part"));
    let url = format!("https://arxiv.org/e-print/{arxiv_id}");
    download(&url, &archive, arxiv_id, app).await?;

    let staging = root.join(format!("{id}.tmp"));
    std::fs::remove_dir_all(&staging).ok();
    std::fs::create_dir_all(&staging).map_err(|e| format!("Could not create folder: {e}"))?;
    let (a, s, aid) = (archive.clone(), staging.clone(), arxiv_id.to_string());
    let result = tokio::task::spawn_blocking(move || extract(&a, &s, &aid))
        .await
        .map_err(|e| format!("Task join error: {e}"))?;
    std::fs::remove_file(&archive).ok();

    let set = match result {
        Ok(set) => set,
        Err(e) => {
            std::fs::remove_dir_all(&staging).ok();
            return Err(e);
        }
    };
    let json = serde_json::to_string_pretty(&set).map_err(|e| e.to_string())?;
    std::fs::write(staging.join(MANIFEST), json).map_err(|e| format!("Write error: {e}"))?;
    let out = root.join(&id);
    std::fs::remove_dir_all(&out).ok();
    std::fs::rename(&staging, &out).map_err(|e| format!("Write error: {e}"))?;
    load(&out, false).ok_or_else(|| "Could not read extracted figures".into())
}

async fn download(url: &str, dest: &Path, arxiv_id: &str, app: Option<&AppHandle>) -> Result<(), String> {
    let resp = crate::http::DOWNLOAD
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download error: {e}"))?;
    match resp.status().as_u16() {
        200..=299 => {}
        403 | 404 => return Err(NO_SOURCE.into()),
        code => return Err(format!("Source download HTTP {code}")),
    }
    let total = resp.content_length().unwrap_or(0);
    if total > MAX_DOWNLOAD {
        return Err(format!("The source bundle is too large ({} MB)", total / (1024 * 1024)));
    }
    let tag = format!("figures:{arxiv_id}");
    let emit = |received: u64, done: bool| {
        if let Some(app) = app {
            let _ = app.emit(
                "download-progress",
                serde_json::json!({ "arxiv_id": tag, "received": received, "total": total, "done": done }),
            );
        }
    };

    let mut file = std::fs::File::create(dest).map_err(|e| format!("Write error: {e}"))?;
    let mut stream = resp.bytes_stream();
    let (mut received, mut last_emit) = (0u64, 0u64);
    let result: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Read error: {e}"))?;
            received += chunk.len() as u64;
            if received > MAX_DOWNLOAD {
                return Err("The source bundle is too large".into());
            }
            file.write_all(&chunk).map_err(|e| format!("Write error: {e}"))?;
            if received - last_emit >= 65_536 {
                last_emit = received;
                emit(received, false);
            }
        }
        file.flush().map_err(|e| format!("Write error: {e}"))
    }
    .await;
    drop(file);
    if result.is_err() {
        std::fs::remove_file(dest).ok();
    }
    emit(received, true);
    result
}

// ---------- Extract ----------

struct Image {
    source: String,
    file: String,
    kind: String,
    bytes: u64,
}

fn ext_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Reads until `buf` is full or the reader ends; returns bytes read.
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

/// A flat, filesystem-safe file name for an archive path, unique within `used`.
fn unique_name(path: &str, used: &mut HashSet<String>) -> String {
    let clean = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
            .collect::<String>()
            .trim_start_matches('.')
            .to_string()
    };
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let base = clean(parts.last().copied().unwrap_or("figure"));
    let base = if base.is_empty() { "figure".to_string() } else { base };
    let mut name = base.clone();
    if used.contains(&name) && parts.len() > 1 {
        let parent = clean(parts[parts.len() - 2]);
        if !parent.is_empty() {
            name = format!("{parent}_{base}");
        }
    }
    let mut n = 2;
    while used.contains(&name) {
        name = format!("{n}_{base}");
        n += 1;
    }
    used.insert(name.clone());
    name
}

/// Unpacks the image files of a source bundle into `out` and describes them.
/// arXiv serves a gzipped tar, a single gzipped .tex, or (for PDF-only
/// submissions) the PDF itself.
fn extract(archive: &Path, out: &Path, arxiv_id: &str) -> Result<FigureSet, String> {
    let open = || std::fs::File::open(archive).map_err(|e| format!("Could not read source: {e}"));
    let mut magic = [0u8; 2];
    let gz = read_full(&mut open()?, &mut magic).map_err(|e| e.to_string())? == 2 && magic == [0x1f, 0x8b];
    let raw: Box<dyn Read> = if gz {
        Box::new(flate2::read::GzDecoder::new(BufReader::new(open()?)))
    } else {
        Box::new(BufReader::new(open()?))
    };
    let mut reader = raw.take(MAX_UNPACKED);
    let mut head = vec![0u8; 512];
    let n = read_full(&mut reader, &mut head).map_err(|e| format!("Could not unpack source: {e}"))?;
    head.truncate(n);
    if head.starts_with(b"%PDF") {
        return Err(NO_SOURCE.into());
    }

    let mut texs: Vec<(String, String)> = Vec::new();
    let mut images: Vec<Image> = Vec::new();
    if n >= 262 && &head[257..262] == b"ustar" {
        let mut tar = tar::Archive::new(std::io::Cursor::new(head).chain(reader));
        let mut used = HashSet::new();
        let mut written = 0u64;
        let entries = tar.entries().map_err(|e| format!("Could not unpack source: {e}"))?;
        for entry in entries {
            // A damaged tail shouldn't throw away what was already read.
            let Ok(mut entry) = entry else { break };
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let Ok(p) = entry.path() else { continue };
            let path = p.to_string_lossy().replace('\\', "/");
            let path = path.trim_start_matches("./").to_string();
            let ext = ext_of(&path);
            let size = entry.size();
            if ext == "tex" || ext == "ltx" {
                let mut buf = Vec::new();
                if (&mut entry).take(MAX_TEX).read_to_end(&mut buf).is_ok() {
                    texs.push((path, String::from_utf8_lossy(&buf).into_owned()));
                }
            } else if IMAGE_EXTS.contains(&ext.as_str()) && size <= MAX_IMAGE && written + size <= MAX_ALL_IMAGES {
                let file = unique_name(&path, &mut used);
                let dest = out.join(&file);
                let mut f = std::fs::File::create(&dest).map_err(|e| format!("Write error: {e}"))?;
                match std::io::copy(&mut (&mut entry).take(MAX_IMAGE), &mut f) {
                    Ok(bytes) => {
                        written += bytes;
                        images.push(Image { source: path, file, kind: ext, bytes });
                    }
                    Err(_) => {
                        drop(f);
                        std::fs::remove_file(&dest).ok();
                        break;
                    }
                }
            }
        }
    } else {
        // A lone .tex file: any figures are drawn in code.
        let mut buf = head;
        reader.take(MAX_TEX).read_to_end(&mut buf).ok();
        texs.push(("main.tex".into(), String::from_utf8_lossy(&buf).into_owned()));
    }

    Ok(FigureSet {
        arxiv_id: arxiv_id.to_string(),
        figures: build_figures(&texs, &images),
        dir: String::new(),
        in_library: false,
    })
}

// ---------- TeX reading ----------
// A light scanner, not a TeX parser: it follows \input, finds figure
// environments and reads \includegraphics / \caption from them. Good enough to
// label figures; anything it misses still shows up under "other images".

/// Removes `%` comments (but not `\%`).
fn strip_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for line in s.lines() {
        let b = line.as_bytes();
        let mut cut = b.len();
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'\\' => i += 2,
                b'%' => {
                    cut = i;
                    break;
                }
                _ => i += 1,
            }
        }
        out.push_str(&line[..cut.min(line.len())]);
        out.push('\n');
    }
    out
}

/// Every control word in `s` as (start, name, index after the name).
fn commands(s: &str) -> Vec<(usize, &str, usize)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'\\' {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_alphabetic() {
            j += 1;
        }
        if j == i + 1 {
            i += 2; // control symbol such as \\ or \%
            continue;
        }
        if j < b.len() && b[j] == b'*' {
            j += 1;
        }
        out.push((start, &s[start + 1..j], j));
        i = j;
    }
    out
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// Skips an optional `[...]` argument, returning the index after it.
fn skip_optional(s: &str, i: usize) -> usize {
    let b = s.as_bytes();
    let j = skip_ws(b, i);
    if j >= b.len() || b[j] != b'[' {
        return i;
    }
    let mut depth = 0i32;
    let mut k = j;
    while k < b.len() {
        match b[k] {
            b'\\' => k += 1,
            b'[' | b'{' => depth += 1,
            b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return k + 1;
                }
            }
            _ => {}
        }
        k += 1;
    }
    i
}

/// Reads a `{...}` argument at `i`, returning its contents and the index after it.
fn read_group(s: &str, i: usize) -> Option<(&str, usize)> {
    let b = s.as_bytes();
    let j = skip_ws(b, i);
    if j >= b.len() || b[j] != b'{' {
        return None;
    }
    let mut depth = 0i32;
    let mut k = j;
    while k < b.len() {
        match b[k] {
            b'\\' => k += 1,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((&s[j + 1..k], k + 1));
                }
            }
            _ => {}
        }
        k += 1;
    }
    None
}

/// The main .tex with every \input / \include inlined, comments removed.
fn assemble(texs: &[(String, String)]) -> String {
    if texs.is_empty() {
        return String::new();
    }
    let files: HashMap<&str, String> = texs.iter().map(|(p, c)| (p.as_str(), strip_comments(c))).collect();
    let main = texs
        .iter()
        .find(|(_, c)| c.contains("\\documentclass") && c.contains("\\begin{document}"))
        .or_else(|| texs.iter().find(|(_, c)| c.contains("\\documentclass")));
    match main {
        Some((path, _)) => {
            let mut seen = HashSet::new();
            inline(path, &files, &mut seen, 0)
        }
        None => texs.iter().map(|(p, _)| files[p.as_str()].as_str()).collect::<Vec<_>>().join("\n"),
    }
}

fn find_tex<'a>(name: &str, files: &'a HashMap<&str, String>) -> Option<&'a str> {
    let name = name.trim().trim_matches('"').trim_start_matches("./");
    let with_ext = if name.ends_with(".tex") || name.ends_with(".ltx") { name.to_string() } else { format!("{name}.tex") };
    files
        .keys()
        .find(|p| **p == with_ext)
        .or_else(|| files.keys().find(|p| p.ends_with(&format!("/{with_ext}"))))
        .copied()
}

fn inline(path: &str, files: &HashMap<&str, String>, seen: &mut HashSet<String>, depth: u32) -> String {
    let src = &files[path];
    if depth > 8 || !seen.insert(path.to_string()) {
        return String::new();
    }
    let mut out = String::with_capacity(src.len());
    let mut last = 0;
    for (start, name, after) in commands(src) {
        if start < last || !matches!(name, "input" | "include" | "subfile") {
            continue;
        }
        let Some((arg, end)) = read_group(src, after) else { continue };
        let Some(child) = find_tex(arg, files) else { continue };
        out.push_str(&src[last..start]);
        out.push_str(&inline(child, files, seen, depth + 1));
        last = end;
    }
    out.push_str(&src[last..]);
    out
}

/// Spans (start of body, end of body) of every `\begin{name}...\end{name}`.
fn env_bodies(s: &str, names: &[&str]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut from = 0;
    for (start, cmd, after) in commands(s) {
        if start < from || cmd != "begin" {
            continue;
        }
        let Some((env, body_start)) = read_group(s, after) else { continue };
        if !names.contains(&env) {
            continue;
        }
        let end_tag = format!("\\end{{{env}}}");
        let Some(len) = s[body_start..].find(&end_tag) else { continue };
        out.push((body_start, body_start + len));
        from = body_start + len + end_tag.len();
    }
    out
}

/// Image names referenced in `s`, with their positions.
fn graphics_refs(s: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    for (start, name, after) in commands(s) {
        match name {
            "includegraphics" | "includegraphics*" | "epsfbox" | "plotone" | "includesvg" => {
                let i = skip_optional(s, skip_optional(s, after));
                if let Some((arg, _)) = read_group(s, i) {
                    out.push((start, arg.to_string()));
                }
            }
            "plottwo" => {
                if let Some((a, i)) = read_group(s, after) {
                    out.push((start, a.to_string()));
                    if let Some((b, _)) = read_group(s, i) {
                        out.push((start, b.to_string()));
                    }
                }
            }
            "epsfig" | "psfig" => {
                if let Some((arg, _)) = read_group(s, after) {
                    let file = arg.split(',').find_map(|kv| {
                        let (k, v) = kv.split_once('=')?;
                        matches!(k.trim(), "file" | "figure").then(|| v.trim().to_string())
                    });
                    if let Some(f) = file {
                        out.push((start, f));
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn strip_image_ext(s: &str) -> &str {
    match s.rsplit_once('.') {
        Some((stem, ext)) if IMAGE_EXTS.contains(&ext.to_ascii_lowercase().as_str()) => stem,
        _ => s,
    }
}

/// Matches a graphics reference to an extracted image. Tries the exact path,
/// then the path without extension, then a path suffix (covers \graphicspath),
/// then the bare file name (covers macros like \figdir/plot).
fn resolve(name: &str, images: &[Image]) -> Option<usize> {
    let n = name.trim().trim_matches('"').replace(['{', '}'], "").replace('\\', "/");
    let n = n.trim_start_matches("./");
    if n.is_empty() {
        return None;
    }
    let n_stem = strip_image_ext(n);
    let n_base = n_stem.rsplit('/').next().unwrap_or(n_stem);
    let rank = |kind: &str| IMAGE_EXTS.iter().position(|e| *e == kind).unwrap_or(IMAGE_EXTS.len());
    images
        .iter()
        .enumerate()
        .filter_map(|(i, img)| {
            let stem = strip_image_ext(&img.source);
            let score = if img.source == n {
                0
            } else if stem == n_stem {
                10 + rank(&img.kind)
            } else if img.source.ends_with(&format!("/{n}")) {
                20
            } else if stem.ends_with(&format!("/{n_stem}")) {
                30 + rank(&img.kind)
            } else if stem.rsplit('/').next() == Some(n_base) {
                40 + rank(&img.kind)
            } else {
                return None;
            };
            Some((score, i))
        })
        .min()
        .map(|(_, i)| i)
}

/// Argument-free macros defined with \newcommand or \def, so captions keep
/// words like a model name that the paper spells as `\ourmodel{}`.
fn simple_macros(doc: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let b = doc.as_bytes();
    for (_, cmd, after) in commands(doc) {
        let (name, i) = match cmd.trim_end_matches('*') {
            "newcommand" | "renewcommand" | "providecommand" => match read_group(doc, after) {
                Some((n, i)) => (n.trim(), i),
                None => {
                    // \newcommand\name{...}
                    let j = skip_ws(b, after);
                    let Some(&(_, n, i)) = commands(&doc[j..]).first().filter(|c| c.0 == 0) else { continue };
                    (&doc[j..j + 1 + n.len()], j + i)
                }
            },
            "def" => {
                let Some(&(_, n, i)) = commands(&doc[after..]).first().filter(|c| c.0 == 0) else { continue };
                (&doc[after..after + 1 + n.len()], after + i)
            }
            _ => continue,
        };
        let Some(name) = name.strip_prefix('\\') else { continue };
        // Macros with parameters are left alone.
        let j = skip_ws(b, i);
        if j < b.len() && (b[j] == b'[' || b[j] == b'#') {
            continue;
        }
        if let Some((body, _)) = read_group(doc, i) {
            if !body.contains('#') {
                out.entry(name.to_string()).or_insert_with(|| body.to_string());
            }
        }
    }
    out
}

/// Turns caption LaTeX into readable text, leaving `$...$` math for KaTeX.
/// `macros` are expanded one level deep.
fn latex_to_text(s: &str, macros: &HashMap<String, String>) -> String {
    let mut out = String::new();
    let mut in_math = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' {
            in_math = !in_math;
            out.push(c);
            continue;
        }
        if c == '\\' && matches!(chars.peek(), Some('(' | '[' | ')' | ']')) {
            chars.next();
            in_math = !in_math;
            out.push('$');
            continue;
        }
        if in_math {
            out.push(if c == '\n' { ' ' } else { c });
            continue;
        }
        match c {
            '\\' => {
                let mut name = String::new();
                while let Some(&n) = chars.peek() {
                    if !n.is_ascii_alphabetic() {
                        break;
                    }
                    name.push(n);
                    chars.next();
                }
                if name.is_empty() {
                    match chars.next() {
                        Some('\\') | Some(',') | Some(' ') | Some(';') => out.push(' '),
                        Some(ch) => out.push(ch),
                        None => {}
                    }
                    continue;
                }
                // Arguments that shouldn't appear in the text.
                let drop_arg = matches!(name.as_str(), "label" | "cite" | "citep" | "citet" | "citealp" | "ref" | "eqref" | "autoref" | "cref" | "Cref" | "vspace" | "hspace");
                if drop_arg {
                    while chars.peek() == Some(&'*') { chars.next(); }
                    let mut depth = 0;
                    for ch in chars.by_ref() {
                        match ch {
                            '[' | '{' => depth += 1,
                            ']' => depth -= 1,
                            '}' => {
                                depth -= 1;
                                if depth == 0 { break; }
                            }
                            _ => {}
                        }
                    }
                    match name.as_str() {
                        "cite" | "citep" | "citet" | "citealp" => out.push_str("[ref]"),
                        "ref" | "eqref" | "autoref" | "cref" | "Cref" => out.push_str("??"),
                        _ => {}
                    }
                } else if matches!(name.as_str(), "ldots" | "dots") {
                    out.push('…');
                } else if let Some(body) = macros.get(&name) {
                    out.push_str(&latex_to_text(body, &HashMap::new()));
                }
            }
            '{' | '}' => {}
            '~' | '\n' | '\t' => out.push(' '),
            _ => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn build_figures(texs: &[(String, String)], images: &[Image]) -> Vec<Figure> {
    let doc = assemble(texs);
    let macros = simple_macros(&doc);
    let mut figures = Vec::new();
    let mut referenced = HashSet::new();
    let mut counter = 0u32;

    for (b0, b1) in env_bodies(&doc, FIGURE_ENVS) {
        let body = &doc[b0..b1];
        let subs = env_bodies(body, &["subfigure", "subtable"]);
        let in_sub = |pos: usize| subs.iter().any(|&(s, e)| pos >= s && pos < e);
        // Only top-level captions number figures; sub-captions label panels.
        let captions: Vec<(usize, String)> = commands(body)
            .into_iter()
            .filter(|(start, name, _)| *name == "caption" && !in_sub(*start))
            .filter_map(|(_, _, after)| {
                let (text, end) = read_group(body, skip_optional(body, after))?;
                Some((end, latex_to_text(text, &macros)))
            })
            .collect();

        // Group images by caption: each image belongs to the first caption that
        // ends after it (captions usually follow their images), else the last.
        let mut groups: Vec<(Option<String>, Vec<String>)> = if captions.is_empty() {
            vec![(None, Vec::new())]
        } else {
            captions.iter().map(|(_, t)| (Some(t.clone()), Vec::new())).collect()
        };
        for (pos, name) in graphics_refs(body) {
            let k = captions.iter().position(|(end, _)| *end > pos).unwrap_or(groups.len() - 1);
            groups[k].1.push(name);
        }

        for (caption, refs) in groups {
            let number = caption.as_ref().map(|_| {
                counter += 1;
                counter
            });
            let caption = caption.unwrap_or_default();
            let mut found: Vec<usize> = Vec::new();
            for r in &refs {
                if let Some(i) = resolve(r, images) {
                    if !found.contains(&i) {
                        found.push(i);
                    }
                }
            }
            if found.is_empty() {
                if number.is_some() {
                    let kind = if refs.is_empty() { "code" } else { "missing" };
                    figures.push(Figure { number, part: None, caption, file: None, source: refs.first().cloned(), kind: kind.into(), bytes: 0, path: None });
                }
                continue;
            }
            let multi = found.len() > 1;
            for (k, &i) in found.iter().enumerate() {
                referenced.insert(i);
                let img = &images[i];
                figures.push(Figure {
                    number,
                    part: multi.then(|| panel_letter(k)),
                    caption: caption.clone(),
                    file: Some(img.file.clone()),
                    source: Some(img.source.clone()),
                    kind: img.kind.clone(),
                    bytes: img.bytes,
                    path: None,
                });
            }
        }
    }

    // Images outside figure environments: those the text includes first, in
    // reading order, then the rest.
    let mut rest: Vec<usize> = graphics_refs(&doc).iter().filter_map(|(_, n)| resolve(n, images)).collect();
    rest.extend(0..images.len());
    for i in rest {
        if referenced.insert(i) {
            let img = &images[i];
            figures.push(Figure {
                number: None,
                part: None,
                caption: String::new(),
                file: Some(img.file.clone()),
                source: Some(img.source.clone()),
                kind: img.kind.clone(),
                bytes: img.bytes,
                path: None,
            });
        }
    }
    figures
}

fn panel_letter(k: usize) -> String {
    if k < 26 {
        ((b'a' + k as u8) as char).to_string()
    } else {
        format!("{}", k + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(source: &str) -> Image {
        Image { source: source.into(), file: source.rsplit('/').next().unwrap().into(), kind: ext_of(source), bytes: 1 }
    }

    #[test]
    fn strips_comments_but_not_escaped_percent() {
        assert_eq!(strip_comments("50\\% done % note\nnext"), "50\\% done \nnext\n");
    }

    #[test]
    fn caption_text_is_readable() {
        assert_eq!(
            latex_to_text("\\textbf{Phase diagram} of $\\alpha_{1}$ vs.~$T$\\label{fig:pd}, see Ref.~\\cite{x} and Fig.~\\ref{fig:a}.", &HashMap::new()),
            "Phase diagram of $\\alpha_{1}$ vs. $T$, see Ref. [ref] and Fig. ??."
        );
    }

    #[test]
    fn expands_argument_free_macros() {
        let doc = r"\newcommand{\model}{Mistral 7B}\def\ours{\textsc{Ours}}\newcommand\bare{Bare}\newcommand{\arg}[1]{#1}";
        let m = simple_macros(doc);
        assert_eq!(m.get("model").map(String::as_str), Some("Mistral 7B"));
        assert_eq!(m.get("bare").map(String::as_str), Some("Bare"));
        assert!(!m.contains_key("arg"));
        assert_eq!(latex_to_text("\\model{} beats \\ours.", &m), "Mistral 7B beats Ours.");
    }

    #[test]
    fn resolves_by_stem_suffix_and_basename() {
        let images = vec![img("figs/plot.eps"), img("figs/plot.pdf"), img("other/map.png")];
        assert_eq!(resolve("figs/plot", &images), Some(1)); // pdf preferred over eps
        assert_eq!(resolve("plot.eps", &images), Some(0));
        assert_eq!(resolve("./other/map.png", &images), Some(2));
        assert_eq!(resolve("\\figdir/map", &images), Some(2));
        assert_eq!(resolve("absent", &images), None);
    }

    #[test]
    fn numbers_figures_panels_and_code_figures() {
        let main = r"\documentclass{article}
\begin{document}
\input{sec/results}
\begin{figure}\begin{tikzpicture}\end{tikzpicture}\caption{Sketch}\end{figure}
\begin{figure}\includegraphics{uncaptioned}\end{figure}
\end{document}";
        let results = r"\begin{figure*}[t]
  \begin{subfigure}{0.5\linewidth}\includegraphics[width=\linewidth]{a}\caption{left}\end{subfigure}
  \begin{subfigure}{0.5\linewidth}\includegraphics{b.png}\caption{right}\end{subfigure}
  \caption[short]{Two {\em panels}.}
\end{figure*}
% \begin{figure}\includegraphics{commented}\caption{no}\end{figure}";
        let texs = vec![("main.tex".to_string(), main.to_string()), ("sec/results.tex".to_string(), results.to_string())];
        let images = vec![img("a.pdf"), img("b.png"), img("uncaptioned.jpg"), img("logo.png")];
        let figs = build_figures(&texs, &images);
        let summary: Vec<(Option<u32>, Option<&str>, &str, &str)> =
            figs.iter().map(|f| (f.number, f.part.as_deref(), f.kind.as_str(), f.caption.as_str())).collect();
        assert_eq!(
            summary,
            vec![
                (Some(1), Some("a"), "pdf", "Two panels."),
                (Some(1), Some("b"), "png", "Two panels."),
                (Some(2), None, "code", "Sketch"),
                (None, None, "jpg", ""),
                (None, None, "png", ""),
            ]
        );
    }

    #[test]
    fn two_captions_in_one_float_are_two_figures() {
        let tex = r"\documentclass{x}\begin{document}\begin{figure}
\begin{minipage}{.5\textwidth}\includegraphics{one}\caption{First}\end{minipage}
\begin{minipage}{.5\textwidth}\plotone{two}\caption{Second}\end{minipage}
\end{figure}\end{document}";
        let images = vec![img("one.png"), img("two.eps")];
        let figs = build_figures(&[("m.tex".into(), tex.into())], &images);
        assert_eq!(figs.len(), 2);
        assert_eq!((figs[0].number, figs[0].caption.as_str(), figs[0].part.as_deref()), (Some(1), "First", None));
        assert_eq!((figs[1].number, figs[1].caption.as_str(), figs[1].kind.as_str()), (Some(2), "Second", "eps"));
    }

    #[test]
    fn unique_names_never_escape_the_folder() {
        let mut used = HashSet::new();
        assert_eq!(unique_name("../../etc/passwd.png", &mut used), "passwd.png");
        assert_eq!(unique_name("a/passwd.png", &mut used), "a_passwd.png");
        assert_eq!(unique_name("b/../passwd.png", &mut used), "2_passwd.png");
        assert_eq!(unique_name("x/..png", &mut used), "png");
    }

    fn tar_gz(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, data) in files {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            builder.append_data(&mut h, name, *data).unwrap();
        }
        let tar = builder.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&tar).unwrap();
        gz.finish().unwrap()
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("figtest-{}-{name}", std::process::id()));
        std::fs::remove_dir_all(&d).ok();
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn extracts_images_from_tar_gz() {
        let dir = temp("tar");
        let tex = b"\\documentclass{x}\\begin{document}\\begin{figure}\\includegraphics{fig/p}\\caption{Plot}\\end{figure}\\end{document}";
        let archive = dir.join("src");
        std::fs::write(&archive, tar_gz(&[("main.tex", tex), ("fig/p.png", b"\x89PNG data"), ("notes.txt", b"skip")])).unwrap();
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let set = extract(&archive, &out, "1234.5678").unwrap();
        assert_eq!(set.figures.len(), 1);
        assert_eq!(set.figures[0].number, Some(1));
        assert_eq!(set.figures[0].file.as_deref(), Some("p.png"));
        assert_eq!(std::fs::read(out.join("p.png")).unwrap(), b"\x89PNG data");
        assert!(!out.join("notes.txt").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn single_tex_and_pdf_only_sources() {
        let dir = temp("single");
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let archive = dir.join("src");
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(b"\\documentclass{x}\\begin{document}\\begin{figure}\\caption{Drawn}\\end{figure}\\end{document}").unwrap();
        std::fs::write(&archive, gz.finish().unwrap()).unwrap();
        let set = extract(&archive, &out, "x").unwrap();
        assert_eq!(set.figures.len(), 1);
        assert_eq!(set.figures[0].kind, "code");

        std::fs::write(&archive, b"%PDF-1.5 ...").unwrap();
        assert_eq!(extract(&archive, &out, "x").unwrap_err(), NO_SOURCE);
        std::fs::remove_dir_all(&dir).ok();
    }
}

/// Hits arXiv: `cargo test figures::live -- --ignored --nocapture`.
#[cfg(test)]
mod live {
    #[tokio::test]
    #[ignore]
    async fn fetches_real_papers() {
        for id in std::env::var("FIG_IDS").unwrap_or("1706.03762 2310.06825".into()).split_whitespace() {
            match super::fetch(id, None).await {
                Ok(set) => {
                    println!("{id}: {} entries in {}", set.figures.len(), set.dir);
                    for f in set.figures.iter().take(12) {
                        println!("  {:?}{} [{}] {:?} — {}", f.number, f.part.clone().unwrap_or_default(), f.kind, f.file, f.caption.chars().take(90).collect::<String>());
                    }
                }
                Err(e) => println!("{id}: ERROR {e}"),
            }
        }
    }
}

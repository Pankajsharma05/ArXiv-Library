// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Pankaj Sharma. See LICENSE.

mod arxiv;
mod crossref;
mod db;
mod downloader;
mod figures;
mod http;
mod semantic;
mod settings;

use arxiv::{Paper, SearchPage};
use db::{Backup, Collection, Db, Edge, Tag, HistoryEntry, BibEntry, BibFolder, BibTag};
use settings::{Settings, SettingsStore, SavedSearch};
use serde::Serialize;
use tauri::State;

struct AppState {
    db: Db,
    settings: SettingsStore,
}

#[derive(Serialize)]
struct LibrarySnapshot {
    papers: Vec<Paper>,
    collections: Vec<Collection>,
    membership: Vec<(String, String)>,
    edges: Vec<Edge>,
    tags: Vec<Tag>,
    paper_tags: Vec<(String, String)>,
}

#[tauri::command]
async fn search_arxiv(
    query: String,
    sort_by: String,
    max_results: Option<u32>,
    start: Option<u32>,
) -> Result<SearchPage, String> {
    // arXiv rejects very large pages; keep requests within its documented limits.
    let max = max_results.unwrap_or(40).clamp(1, 500);
    arxiv::search(&query, start.unwrap_or(0), max, &sort_by).await
}

/// If `input` is one or more arXiv ids / arxiv.org URLs (separated by spaces,
/// commas or newlines), fetch exactly those papers. Returns None when the input
/// is an ordinary search query, so the caller can fall back to a normal search.
#[tauri::command]
async fn lookup_arxiv_ids(input: String) -> Result<Option<Vec<Paper>>, String> {
    let tokens: Vec<&str> = input
        .split(|c: char| c.is_whitespace() || c == ',' || c == ';')
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return Ok(None);
    }
    let mut ids = Vec::new();
    for t in tokens {
        match arxiv::parse_id(t) {
            Some(id) => { if !ids.contains(&id) { ids.push(id) } }
            None => return Ok(None),
        }
    }
    arxiv::fetch_by_ids(&ids).await.map(Some)
}

#[tauri::command]
async fn get_library(state: State<'_, AppState>) -> Result<LibrarySnapshot, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(LibrarySnapshot {
            papers: db.all_papers()?,
            collections: db.all_collections()?,
            membership: db.all_membership()?,
            edges: db.all_edges()?,
            tags: db.all_tags()?,
            paper_tags: db.all_paper_tags()?,
        })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
fn save_paper(state: State<AppState>, paper: Paper, collection_id: Option<String>) -> Result<(), String> {
    state.db.save_paper(&paper)?;
    if let Some(cid) = collection_id {
        state.db.assign(&paper.arxiv_id, &cid)?;
    }
    Ok(())
}

/// Save many papers at once (optionally into a collection). Papers already in
/// the trash are restored.
#[tauri::command]
fn save_papers(state: State<AppState>, papers: Vec<Paper>, collection_id: Option<String>) -> Result<(), String> {
    state.db.save_papers(&papers, collection_id.as_deref())
}

#[tauri::command]
fn bulk_set_trashed(state: State<AppState>, ids: Vec<String>, trashed: bool) -> Result<(), String> {
    state.db.bulk_set_trashed(&ids, trashed)
}

#[tauri::command]
fn bulk_set_reading_status(state: State<AppState>, ids: Vec<String>, status: String) -> Result<(), String> {
    state.db.bulk_set_reading_status(&ids, &status)
}

#[tauri::command]
fn bulk_assign(state: State<AppState>, ids: Vec<String>, collection_id: String) -> Result<(), String> {
    state.db.bulk_assign(&ids, &collection_id)
}

#[tauri::command]
fn bulk_unassign(state: State<AppState>, ids: Vec<String>, collection_id: String) -> Result<(), String> {
    state.db.bulk_unassign(&ids, &collection_id)
}

#[tauri::command]
fn bulk_tag(state: State<AppState>, ids: Vec<String>, tag_id: String) -> Result<(), String> {
    state.db.bulk_tag(&ids, &tag_id)
}

/// Permanently delete papers and their downloaded PDFs.
#[tauri::command]
fn bulk_delete_papers(state: State<AppState>, ids: Vec<String>) -> Result<u32, String> {
    let paths = state.db.bulk_delete_papers(&ids)?;
    for p in &paths { downloader::delete(p); }
    prune_figures(&state);
    Ok(ids.len() as u32)
}

#[tauri::command]
fn delete_paper(state: State<AppState>, id: String) -> Result<(), String> {
    if let Some(path) = state.db.delete_paper(&id)? {
        downloader::delete(&path);
    }
    prune_figures(&state);
    Ok(())
}

#[tauri::command]
fn update_note(state: State<AppState>, id: String, note: String) -> Result<(), String> {
    state.db.update_note(&id, &note)
}

#[tauri::command]
async fn download_pdf(app: tauri::AppHandle, state: State<'_, AppState>, paper: Paper) -> Result<String, String> {
    // Ensure it's saved first.
    state.db.save_paper(&paper)?;
    let path = downloader::download(&paper, Some(&app)).await?;
    state.db.set_local_path(&paper.arxiv_id, &path)?;
    Ok(path)
}

#[tauri::command]
fn read_pdf_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("Could not read PDF file: {e}"))
}

/// Writes arbitrary text (e.g. a DOI/link list) to a chosen path.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Could not write file: {e}"))
}

/// Downloads the PDF to a temp file and returns its path, WITHOUT saving the
/// paper to the library. The frontend opens this in the system PDF app.
#[tauri::command]
async fn open_pdf_temp(app: tauri::AppHandle, paper: Paper) -> Result<String, String> {
    downloader::download_to_temp(&paper, Some(&app)).await
}

#[tauri::command]
async fn save_to_downloads(app: tauri::AppHandle, state: State<'_, AppState>, paper: Paper) -> Result<String, String> {
    // Make sure we have the PDF locally first (downloads + caches if needed).
    state.db.save_paper(&paper)?;
    let local = downloader::download(&paper, Some(&app)).await?;
    state.db.set_local_path(&paper.arxiv_id, &local)?;

    let downloads = dirs::download_dir()
        .ok_or_else(|| "Could not locate the Downloads folder".to_string())?;
    std::fs::create_dir_all(&downloads).ok();

    // A readable filename: "<arxiv_id> - <title>.pdf", sanitized.
    let safe_title: String = paper
        .title
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let trimmed = safe_title.trim();
    let short: String = trimmed.chars().take(100).collect();
    let filename = format!("{} - {}.pdf", paper.arxiv_id.replace('/', "_"), short);
    let dest = downloads.join(filename);
    std::fs::copy(&local, &dest).map_err(|e| format!("Could not copy to Downloads: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
fn add_collection(state: State<AppState>, name: String, parent_id: Option<String>) -> Result<Collection, String> {
    state.db.add_collection(&name, parent_id)
}

#[tauri::command]
fn rename_collection(state: State<AppState>, id: String, name: String) -> Result<(), String> {
    state.db.rename_collection(&id, &name)
}

#[tauri::command]
fn set_collection_color(state: State<AppState>, id: String, color: Option<String>) -> Result<(), String> {
    state.db.set_collection_color(&id, color)
}

#[tauri::command]
fn reorder_collections(state: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    state.db.reorder_collections(ids)
}

#[tauri::command]
fn reorder_tags(state: State<AppState>, ids: Vec<String>) -> Result<(), String> {
    state.db.reorder_tags(ids)
}

#[tauri::command]
fn delete_collection(state: State<AppState>, id: String) -> Result<(), String> {
    state.db.delete_collection(&id)
}

#[tauri::command]
fn assign_paper(state: State<AppState>, paper_id: String, collection_id: String) -> Result<(), String> {
    state.db.assign(&paper_id, &collection_id)
}

#[tauri::command]
fn unassign_paper(state: State<AppState>, paper_id: String, collection_id: String) -> Result<(), String> {
    state.db.unassign(&paper_id, &collection_id)
}

#[tauri::command]
fn add_edge(state: State<AppState>, source: String, target: String, label: String, direction: String) -> Result<Edge, String> {
    state.db.add_edge(&source, &target, &label, &direction)
}

#[tauri::command]
fn update_edge(state: State<AppState>, id: String, label: String, direction: String) -> Result<(), String> {
    state.db.update_edge(&id, &label, &direction)
}

#[tauri::command]
fn delete_edge(state: State<AppState>, id: String) -> Result<(), String> {
    state.db.delete_edge(&id)
}

// ---- Settings & usage ----

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.get()
}

#[tauri::command]
fn set_name(state: State<AppState>, name: String) {
    state.settings.set_name(name);
}

#[tauri::command]
fn record_usage(state: State<AppState>, seconds: u64) {
    state.settings.add_usage(seconds);
}

#[tauri::command]
fn set_followed_categories(state: State<AppState>, categories: Vec<String>) {
    state.settings.set_followed_categories(categories);
}

#[tauri::command]
fn set_history_enabled(state: State<AppState>, enabled: bool) {
    state.settings.set_history_enabled(enabled);
    if !enabled {
        // Clearing on disable keeps things tidy and private.
        let _ = state.db.clear_history();
    }
}

#[tauri::command]
fn set_saved_searches(state: State<AppState>, searches: Vec<SavedSearch>) {
    state.settings.set_saved_searches(searches);
}

#[tauri::command]
#[allow(non_snake_case)]
fn set_appearance(state: State<AppState>, fontScale: u32, fontFamily: String) {
    state.settings.set_appearance(fontScale, fontFamily);
}

#[tauri::command]
fn export_settings(state: State<AppState>) -> Result<String, String> {
    serde_json::to_string_pretty(&state.settings.get()).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_settings(state: State<AppState>, json: String) -> Result<(), String> {
    let raw: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("Invalid settings file: {e}"))?;
    let s: Settings = serde_json::from_value(raw.clone()).map_err(|e| format!("Invalid settings file: {e}"))?;
    state.settings.import_from(&s, &raw);
    Ok(())
}

#[tauri::command]
async fn fetch_paper_metrics(arxiv_id: String) -> Result<semantic::PaperMetrics, String> {
    semantic::fetch_metrics(&arxiv_id).await
}

/// Citation metrics for many papers in one Semantic Scholar batch request.
#[tauri::command]
async fn fetch_metrics_batch(arxiv_ids: Vec<String>) -> Result<Vec<semantic::PaperMetrics>, String> {
    semantic::fetch_metrics_batch(&arxiv_ids).await
}

// ---- View history ----

#[tauri::command]
fn record_view(state: State<AppState>, entry: HistoryEntry) -> Result<(), String> {
    if !state.settings.get().history_enabled {
        return Ok(()); // history tracking is off
    }
    state.db.record_view(&entry)
}

#[tauri::command]
fn get_history(state: State<AppState>) -> Result<Vec<HistoryEntry>, String> {
    state.db.all_history()
}

#[tauri::command]
fn clear_history(state: State<AppState>) -> Result<(), String> {
    state.db.clear_history()
}

// ---- Bibliography ----

#[tauri::command]
async fn fetch_citation(doi: String) -> Result<crossref::Citation, String> {
    crossref::fetch_citation(&doi).await
}

/// Resolve a saved arXiv paper to its published DOI and fetch the journal citation.
/// Returns Ok(None) if the paper has no published DOI yet (still a preprint).
#[tauri::command]
async fn fetch_published_citation(arxiv_id: String) -> Result<Option<crossref::Citation>, String> {
    match semantic::resolve_doi(&arxiv_id).await? {
        Some(doi) => {
            let cite = crossref::fetch_citation(&doi).await?;
            Ok(Some(cite))
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn add_bib_entry(state: State<AppState>, doi: Option<String>, raw_json: String) -> Result<String, String> {
    state.db.add_bib_entry(doi, &raw_json)
}

#[tauri::command]
fn delete_bib_entry(state: State<AppState>, id: String) -> Result<(), String> {
    state.db.delete_bib_entry(&id)
}

#[tauri::command]
fn get_bib_entries(state: State<AppState>) -> Result<Vec<BibEntry>, String> {
    state.db.all_bib_entries()
}

// ---- Collection archive ----
#[tauri::command]
fn set_collection_archived(state: State<AppState>, id: String, archived: bool) -> Result<(), String> {
    state.db.set_collection_archived(&id, archived)
}

// ---- Bib folders ----
#[tauri::command]
fn add_bib_folder(state: State<AppState>, name: String) -> Result<BibFolder, String> {
    state.db.add_bib_folder(&name)
}
#[tauri::command]
fn rename_bib_folder(state: State<AppState>, id: String, name: String) -> Result<(), String> {
    state.db.rename_bib_folder(&id, &name)
}
#[tauri::command]
fn set_bib_folder_color(state: State<AppState>, id: String, color: Option<String>) -> Result<(), String> {
    state.db.set_bib_folder_color(&id, color)
}
#[tauri::command]
fn delete_bib_folder(state: State<AppState>, id: String) -> Result<(), String> {
    state.db.delete_bib_folder(&id)
}
#[tauri::command]
fn get_bib_folders(state: State<AppState>) -> Result<Vec<BibFolder>, String> {
    state.db.all_bib_folders()
}
#[tauri::command]
fn assign_bib_folder(state: State<AppState>, bib_id: String, folder_id: String) -> Result<(), String> {
    state.db.assign_bib_folder(&bib_id, &folder_id)
}
#[tauri::command]
fn unassign_bib_folder(state: State<AppState>, bib_id: String, folder_id: String) -> Result<(), String> {
    state.db.unassign_bib_folder(&bib_id, &folder_id)
}

// ---- Bib tags ----
#[tauri::command]
fn add_bib_tag(state: State<AppState>, name: String, color: Option<String>) -> Result<BibTag, String> {
    state.db.add_bib_tag(&name, color)
}
#[tauri::command]
fn delete_bib_tag(state: State<AppState>, id: String) -> Result<(), String> {
    state.db.delete_bib_tag(&id)
}
#[tauri::command]
fn get_bib_tags(state: State<AppState>) -> Result<Vec<BibTag>, String> {
    state.db.all_bib_tags()
}
#[tauri::command]
fn assign_bib_tag(state: State<AppState>, bib_id: String, tag_id: String) -> Result<(), String> {
    state.db.assign_bib_tag(&bib_id, &tag_id)
}
#[tauri::command]
fn unassign_bib_tag(state: State<AppState>, bib_id: String, tag_id: String) -> Result<(), String> {
    state.db.unassign_bib_tag(&bib_id, &tag_id)
}

// ---- PDF management ----

/// Total bytes used by downloaded PDFs.
#[tauri::command]
fn pdf_storage_used(state: State<AppState>) -> Result<u64, String> {
    let mut total = 0u64;
    for (_, path) in state.db.papers_with_pdfs()? {
        if let Ok(meta) = std::fs::metadata(&path) {
            total += meta.len();
        }
    }
    Ok(total)
}

/// Delete the downloaded PDF for a single paper (keeps the library entry).
#[tauri::command]
fn delete_pdf(state: State<AppState>, id: String) -> Result<(), String> {
    if let Some(path) = state.db.clear_local_path(&id)? {
        downloader::delete(&path);
    }
    Ok(())
}

/// Delete downloaded PDFs for every paper in a collection.
#[tauri::command]
fn delete_pdfs_in_collection(state: State<AppState>, collection_id: String) -> Result<u32, String> {
    let mut count = 0;
    let papers = state.db.all_papers()?;
    let membership = state.db.all_membership()?;
    let in_col: std::collections::HashSet<String> = membership
        .into_iter()
        .filter(|(_, cid)| *cid == collection_id)
        .map(|(pid, _)| pid)
        .collect();
    for p in papers {
        if in_col.contains(&p.arxiv_id) && p.local_pdf_path.is_some() {
            if let Some(path) = state.db.clear_local_path(&p.arxiv_id)? {
                downloader::delete(&path);
                count += 1;
            }
        }
    }
    Ok(count)
}

/// Delete all downloaded PDFs across the whole library.
#[tauri::command]
fn delete_all_pdfs(state: State<AppState>) -> Result<u32, String> {
    let mut count = 0;
    for (id, path) in state.db.papers_with_pdfs()? {
        downloader::delete(&path);
        let _ = state.db.clear_local_path(&id)?;
        count += 1;
    }
    Ok(count)
}

// ---- Source figures ----

/// Drops kept figures of papers that were permanently deleted.
fn prune_figures(state: &AppState) {
    if let Ok(papers) = state.db.all_papers() {
        let ids: Vec<String> = papers.into_iter().map(|p| p.arxiv_id).collect();
        figures::prune(&ids);
    }
}

/// Figures already fetched for a paper, without touching the network.
#[tauri::command]
fn cached_figures(arxiv_id: String) -> Option<figures::FigureSet> {
    figures::cached(&arxiv_id)
}

/// Downloads the paper's LaTeX source and extracts its figures (cached).
#[tauri::command]
async fn fetch_figures(app: tauri::AppHandle, arxiv_id: String) -> Result<figures::FigureSet, String> {
    figures::fetch(&arxiv_id, Some(&app)).await
}

/// Raw bytes of a figure for previews, sent without JSON encoding.
#[tauri::command]
fn read_figure(path: String) -> Result<tauri::ipc::Response, String> {
    figures::read(&path).map(tauri::ipc::Response::new)
}

/// Copies figures (all, or the named files) into ~/Downloads/<id>_figures/.
#[tauri::command]
fn save_figures_to_downloads(arxiv_id: String, files: Option<Vec<String>>) -> Result<(String, u32), String> {
    figures::save_to_downloads(&arxiv_id, files)
}

/// Keeps a paper's figures in the library, saving the paper if needed.
#[tauri::command]
fn keep_figures(state: State<AppState>, paper: Paper) -> Result<figures::FigureSet, String> {
    if !state.db.all_papers()?.iter().any(|p| p.arxiv_id == paper.arxiv_id) {
        state.db.save_paper(&paper)?;
    }
    figures::keep_in_library(&paper.arxiv_id)
}

#[tauri::command]
fn remove_kept_figures(arxiv_id: String) -> Result<(), String> {
    figures::remove_from_library(&arxiv_id)
}

#[tauri::command]
fn figures_storage_used() -> u64 {
    figures::storage_used()
}

#[tauri::command]
fn delete_all_figures() -> u32 {
    figures::delete_all()
}

// ---- Tags ----

#[tauri::command]
fn add_tag(state: State<AppState>, name: String, color: Option<String>) -> Result<Tag, String> {
    state.db.add_tag(&name, color)
}

#[tauri::command]
fn delete_tag(state: State<AppState>, id: String) -> Result<(), String> {
    state.db.delete_tag(&id)
}

#[tauri::command]
fn set_tag_color(state: State<AppState>, id: String, color: Option<String>) -> Result<(), String> {
    state.db.set_tag_color(&id, color)
}

#[tauri::command]
fn tag_paper(state: State<AppState>, paper_id: String, tag_id: String) -> Result<(), String> {
    state.db.tag_paper(&paper_id, &tag_id)
}

#[tauri::command]
fn untag_paper(state: State<AppState>, paper_id: String, tag_id: String) -> Result<(), String> {
    state.db.untag_paper(&paper_id, &tag_id)
}

// ---- Reading status / opened ----

#[tauri::command]
fn set_reading_status(state: State<AppState>, id: String, status: String) -> Result<(), String> {
    state.db.set_reading_status(&id, &status)
}

#[tauri::command]
fn mark_opened(state: State<AppState>, id: String) -> Result<(), String> {
    state.db.mark_opened(&id)
}

#[tauri::command]
fn set_trashed(state: State<AppState>, id: String, trashed: bool) -> Result<(), String> {
    state.db.set_trashed(&id, trashed)
}

#[tauri::command]
fn empty_trash(state: State<AppState>) -> Result<u32, String> {
    let paths = state.db.empty_trash()?;
    let n = paths.len() as u32;
    for p in paths { downloader::delete(&p); }
    prune_figures(&state);
    Ok(n)
}

// ---- Backup / restore ----

#[tauri::command]
async fn export_backup(state: State<'_, AppState>) -> Result<String, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let backup = db.export_backup()?;
        serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn import_backup(state: State<'_, AppState>, json: String) -> Result<(), String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let backup: Backup = serde_json::from_str(&json).map_err(|e| format!("Invalid backup file: {e}"))?;
        db.import_backup(&backup)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Could not read file: {e}"))
}

/// Zooms the whole page natively, like a browser's Ctrl +/-, so dialogs, menus
/// and toasts scale together with the main layout.
#[tauri::command]
fn set_ui_zoom(webview: tauri::Webview, scale: f64) -> Result<(), String> {
    webview.set_zoom(scale.clamp(0.7, 1.6)).map_err(|e| format!("Could not zoom: {e}"))
}

/// Open a file path in the system default app from Rust (bypasses frontend path scope).
#[tauri::command]
fn open_in_default_app(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("Could not open: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = Db::open().expect("failed to open database");
    let settings = SettingsStore::load();
    let zoom = settings.get().font_scale;

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { db, settings })
        .setup(move |app| {
            // Apply the saved zoom before the page paints, avoiding a jump at startup.
            use tauri::Manager;
            if zoom != 100 {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_zoom(zoom as f64 / 100.0);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search_arxiv,
            lookup_arxiv_ids,
            get_library,
            save_paper,
            save_papers,
            bulk_set_trashed,
            bulk_set_reading_status,
            bulk_assign,
            bulk_unassign,
            bulk_tag,
            bulk_delete_papers,
            fetch_metrics_batch,
            delete_paper,
            update_note,
            download_pdf,
            read_pdf_bytes,
            write_text_file,
            open_pdf_temp,
            save_to_downloads,
            add_collection,
            rename_collection,
            set_collection_color,
            reorder_collections,
            reorder_tags,
            delete_collection,
            assign_paper,
            unassign_paper,
            add_edge,
            update_edge,
            delete_edge,
            get_settings,
            set_name,
            record_usage,
            set_followed_categories,
            set_history_enabled,
            set_saved_searches,
            set_appearance,
            export_settings,
            import_settings,
            fetch_paper_metrics,
            record_view,
            get_history,
            clear_history,
            fetch_citation,
            fetch_published_citation,
            add_bib_entry,
            delete_bib_entry,
            get_bib_entries,
            set_collection_archived,
            add_bib_folder,
            rename_bib_folder,
            set_bib_folder_color,
            delete_bib_folder,
            get_bib_folders,
            assign_bib_folder,
            unassign_bib_folder,
            add_bib_tag,
            delete_bib_tag,
            get_bib_tags,
            assign_bib_tag,
            unassign_bib_tag,
            pdf_storage_used,
            delete_pdf,
            delete_pdfs_in_collection,
            delete_all_pdfs,
            cached_figures,
            fetch_figures,
            read_figure,
            save_figures_to_downloads,
            keep_figures,
            remove_kept_figures,
            figures_storage_used,
            delete_all_figures,
            add_tag,
            delete_tag,
            set_tag_color,
            tag_paper,
            untag_paper,
            set_reading_status,
            mark_opened,
            set_trashed,
            empty_trash,
            export_backup,
            import_backup,
            read_text_file,
            open_in_default_app,
            set_ui_zoom,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Network smoke tests for the API clients. They hit the real services, so they
/// are ignored by default: `cargo test -- --ignored --test-threads=1`.
#[cfg(test)]
mod live_tests {
    #[tokio::test]
    #[ignore]
    async fn search_reports_total_and_pages() {
        let page = crate::arxiv::search("all:majorana", 0, 5, "relevance").await.unwrap();
        assert_eq!(page.papers.len(), 5);
        assert!(page.total > 1000, "total = {}", page.total);
    }

    #[tokio::test]
    #[ignore]
    async fn lookup_by_id_and_url() {
        let found = super::lookup_arxiv_ids("https://arxiv.org/abs/1706.03762v5, hep-th/9711200".into())
            .await.unwrap().expect("ids recognised");
        let ids: Vec<_> = found.iter().map(|p| p.arxiv_id.as_str()).collect();
        assert_eq!(ids.len(), 2, "{ids:?}");
        assert!(found[0].title.contains("Attention"));
        assert!(super::lookup_arxiv_ids("attention is all you need".into()).await.unwrap().is_none());
        let none = super::lookup_arxiv_ids("2401.99999".into()).await.unwrap().unwrap();
        assert!(none.is_empty());
    }

    #[tokio::test]
    #[ignore]
    async fn metrics_batch_aligns_with_input() {
        let ids = vec!["1706.03762v5".to_string(), "2401.99999".to_string(), "hep-th/9711200".to_string()];
        let m = crate::semantic::fetch_metrics_batch(&ids).await.unwrap();
        assert_eq!(m.len(), 3);
        assert!(m[0].citation_count.unwrap_or(0) > 1000);
        assert!(m[1].citation_count.is_none());
        assert!(m[2].citation_count.unwrap_or(0) > 1000);
    }

    #[tokio::test]
    #[ignore]
    async fn download_validates_and_caches_pdf() {
        let mut p = crate::arxiv::fetch_by_ids(&["1706.03762v5".into()]).await.unwrap().remove(0);
        let path = crate::downloader::download_to_temp(&p, None).await.unwrap();
        let head = std::fs::read(&path).unwrap();
        assert!(head.starts_with(b"%PDF-"));
        assert!(!std::path::Path::new(&format!("{path}.part")).exists());

        // A corrupt cached file is replaced rather than served forever.
        std::fs::write(&path, b"<html>not a pdf</html>").unwrap();
        let again = crate::downloader::download_to_temp(&p, None).await.unwrap();
        assert!(std::fs::read(&again).unwrap().starts_with(b"%PDF-"));

        // An HTML page instead of a PDF is rejected, and nothing is cached.
        p.arxiv_id = "not-a-pdf".into();
        p.pdf_url = "https://arxiv.org/abs/1706.03762".into();
        assert!(crate::downloader::download_to_temp(&p, None).await.is_err());
        assert!(!std::env::temp_dir().join("arxiv_not-a-pdf.pdf").exists());
    }
}

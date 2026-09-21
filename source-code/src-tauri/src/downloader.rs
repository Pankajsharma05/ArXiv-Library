use crate::arxiv::Paper;
use crate::db::data_dir;
use futures_util::StreamExt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

fn pdf_dir() -> PathBuf {
    let dir = data_dir().join("PDFs");
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// Progress payload emitted to the frontend as bytes arrive.
#[derive(Clone, serde::Serialize)]
struct DownloadProgress {
    arxiv_id: String,
    received: u64,
    total: u64, // 0 when the server doesn't report Content-Length
    done: bool,
}

/// True if the file at `path` starts with the PDF magic bytes. Used both to
/// validate a fresh download and to reject a stale/corrupt cached file.
fn looks_like_pdf(path: &Path) -> bool {
    let mut head = [0u8; 5];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map(|_| &head == b"%PDF-")
        .unwrap_or(false)
}

/// Streams a PDF from `url` to `dest`, emitting "download-progress" events on
/// `app` (if provided) tagged with `arxiv_id`. Returns the saved path.
///
/// Bytes go to a sibling `.part` file which is only renamed into place once the
/// transfer completes and the content is verified to be a PDF. A dropped
/// connection or an HTML error page therefore never ends up cached as the
/// paper's PDF.
async fn stream_to_file(
    url: &str,
    dest: &Path,
    arxiv_id: &str,
    app: Option<&AppHandle>,
) -> Result<String, String> {
    let resp = crate::http::DOWNLOAD
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download error: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("PDF download HTTP {}", resp.status().as_u16()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut received: u64 = 0;
    let mut stream = resp.bytes_stream();

    let part = dest.with_extension("pdf.part");
    let mut file = std::fs::File::create(&part).map_err(|e| format!("Write error: {e}"))?;

    let emit = |received: u64, total: u64, done: bool| {
        if let Some(app) = app {
            let _ = app.emit(
                "download-progress",
                DownloadProgress { arxiv_id: arxiv_id.to_string(), received, total, done },
            );
        }
    };

    // Throttle progress emissions so we don't flood the IPC bridge.
    let mut last_emit: u64 = 0;
    let result: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Read error: {e}"))?;
            received += chunk.len() as u64;
            file.write_all(&chunk).map_err(|e| format!("Write error: {e}"))?;
            if received - last_emit >= 65_536 {
                last_emit = received;
                emit(received, total, false);
            }
        }
        file.flush().map_err(|e| format!("Write error: {e}"))?;
        Ok(())
    }
    .await;
    drop(file);

    if let Err(e) = result {
        std::fs::remove_file(&part).ok();
        return Err(e);
    }
    if !looks_like_pdf(&part) {
        std::fs::remove_file(&part).ok();
        return Err("arXiv did not return a PDF (it may still be generating it). Try again shortly.".into());
    }
    std::fs::rename(&part, dest).map_err(|e| format!("Write error: {e}"))?;
    emit(received, total.max(received), true);
    Ok(dest.to_string_lossy().to_string())
}

/// Reuse `dest` if it holds a valid PDF; otherwise (re)download it.
async fn cached_or_download(paper: &Paper, dest: PathBuf, app: Option<&AppHandle>) -> Result<String, String> {
    if dest.exists() {
        if looks_like_pdf(&dest) {
            return Ok(dest.to_string_lossy().to_string());
        }
        std::fs::remove_file(&dest).ok();
    }
    stream_to_file(&paper.pdf_url, &dest, &paper.arxiv_id, app).await
}

/// Downloads the paper's PDF and returns the absolute path as a string.
pub async fn download(paper: &Paper, app: Option<&AppHandle>) -> Result<String, String> {
    let filename = format!("{}.pdf", paper.arxiv_id.replace('/', "_"));
    cached_or_download(paper, pdf_dir().join(filename), app).await
}

pub fn delete(path: &str) {
    std::fs::remove_file(path).ok();
}

/// Downloads the paper's PDF into the OS temp directory and returns its path.
/// Used for "view without saving to library" — the file is a throwaway.
pub async fn download_to_temp(paper: &Paper, app: Option<&AppHandle>) -> Result<String, String> {
    let filename = format!("arxiv_{}.pdf", paper.arxiv_id.replace('/', "_"));
    cached_or_download(paper, std::env::temp_dir().join(filename), app).await
}

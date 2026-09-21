use serde::{Deserialize, Serialize};
use once_cell::sync::Lazy;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Semantic Scholar's unauthenticated API is tightly rate limited (~1 req/sec,
/// shared across all callers). We serialize every S2 request behind one global
/// throttle so DOI resolution and citation-metric loading never collide and
/// trip HTTP 429.
const S2_MIN_INTERVAL: Duration = Duration::from_millis(1100);
static S2_LAST_REQUEST: Lazy<Mutex<Option<Instant>>> = Lazy::new(|| Mutex::new(None));

async fn s2_throttle() {
    let mut last = S2_LAST_REQUEST.lock().await;
    if let Some(t) = *last {
        let elapsed = t.elapsed();
        if elapsed < S2_MIN_INTERVAL {
            tokio::time::sleep(S2_MIN_INTERVAL - elapsed).await;
        }
    }
    *last = Some(Instant::now());
}

/// Perform a throttled GET against Semantic Scholar, retrying on HTTP 429 with
/// exponential backoff (1s, 2s, 4s). Returns the response on success, or a
/// "rate_limited" error only after the retries are exhausted.
async fn s2_get(url: &str) -> Result<reqwest::Response, String> {
    s2_send(|| crate::http::API.get(url)).await
}

async fn s2_send(build: impl Fn() -> reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    let mut backoff = Duration::from_secs(1);
    for attempt in 0..4 {
        s2_throttle().await;
        let resp = build()
            .send()
            .await
            .map_err(|e| format!("Network error: {e}"))?;
        if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if attempt < 3 {
                tokio::time::sleep(backoff).await;
                backoff *= 2;
                continue;
            }
            return Err("rate_limited".to_string());
        }
        return Ok(resp);
    }
    Err("rate_limited".to_string())
}

/// Citation/venue metadata fetched from Semantic Scholar for a single paper.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PaperMetrics {
    pub arxiv_id: String,
    pub citation_count: Option<u64>,
    pub influential_citation_count: Option<u64>,
    pub venue: Option<String>,
    pub year: Option<u64>,
    /// Semantic Scholar paper URL, if resolved.
    pub url: Option<String>,
}

#[derive(Deserialize)]
struct S2Response {
    #[serde(rename = "citationCount")]
    citation_count: Option<u64>,
    #[serde(rename = "influentialCitationCount")]
    influential_citation_count: Option<u64>,
    venue: Option<String>,
    year: Option<u64>,
    url: Option<String>,
}

const BASE: &str = "https://api.semanticscholar.org/graph/v1/paper";

fn metrics_from(arxiv_id: &str, data: S2Response) -> PaperMetrics {
    PaperMetrics {
        arxiv_id: arxiv_id.to_string(),
        citation_count: data.citation_count,
        influential_citation_count: data.influential_citation_count,
        venue: data.venue.filter(|v| !v.is_empty()),
        year: data.year,
        url: data.url,
    }
}

/// Maximum ids per Semantic Scholar batch request (API limit is 500).
const BATCH_MAX: usize = 400;

/// Fetch metrics for many arXiv ids in as few requests as possible. The
/// batch endpoint answers up to 500 ids per call, versus one id per ~1.1 s
/// with the single-paper endpoint. Ids S2 doesn't know come back with empty
/// metrics. Results are in the same order as `arxiv_ids`.
pub async fn fetch_metrics_batch(arxiv_ids: &[String]) -> Result<Vec<PaperMetrics>, String> {
    let mut out = Vec::with_capacity(arxiv_ids.len());
    for chunk in arxiv_ids.chunks(BATCH_MAX) {
        let ids: Vec<String> = chunk
            .iter()
            .map(|id| format!("ARXIV:{}", crate::arxiv::base_id(id)))
            .collect();
        let body = serde_json::json!({ "ids": ids });
        let url = format!("{BASE}/batch?fields=citationCount,influentialCitationCount,venue,year,url");
        let resp = s2_send(|| crate::http::API.post(&url).json(&body)).await?;
        if !resp.status().is_success() {
            return Err(format!("Semantic Scholar returned {}", resp.status()));
        }
        let data: Vec<Option<S2Response>> =
            resp.json().await.map_err(|e| format!("Parse error: {e}"))?;
        for (id, item) in chunk.iter().zip(data.into_iter().chain(std::iter::repeat_with(|| None))) {
            out.push(match item {
                Some(d) => metrics_from(id, d),
                None => PaperMetrics { arxiv_id: id.clone(), ..Default::default() },
            });
        }
    }
    Ok(out)
}

/// Fetch metrics for one arXiv id (base id, no version suffix).
pub async fn fetch_metrics(arxiv_id: &str) -> Result<PaperMetrics, String> {
    // Strip a trailing version like v2 so the ARXIV: lookup resolves.
    let base = crate::arxiv::base_id(arxiv_id);
    let fields = "citationCount,influentialCitationCount,venue,year,url";
    let url = format!("{BASE}/ARXIV:{base}?fields={fields}");

    let resp = s2_get(&url).await?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        // Paper not indexed yet — return empty metrics rather than an error.
        return Ok(PaperMetrics { arxiv_id: arxiv_id.to_string(), ..Default::default() });
    }
    if !resp.status().is_success() {
        return Err(format!("Semantic Scholar returned {}", resp.status()));
    }

    let data: S2Response = resp.json().await.map_err(|e| format!("Parse error: {e}"))?;
    Ok(metrics_from(arxiv_id, data))
}

#[derive(Deserialize)]
struct ExternalIdsResponse {
    #[serde(rename = "externalIds")]
    external_ids: Option<ExternalIds>,
}

#[derive(Deserialize)]
struct ExternalIds {
    #[serde(rename = "DOI")]
    doi: Option<String>,
}

/// Resolve the published DOI for an arXiv id, if one exists.
/// Returns None when the paper has no journal DOI yet (still just a preprint).
pub async fn resolve_doi(arxiv_id: &str) -> Result<Option<String>, String> {
    let base = crate::arxiv::base_id(arxiv_id);
    let url = format!("{BASE}/ARXIV:{base}?fields=externalIds");
    let resp = s2_get(&url).await?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("Semantic Scholar returned {}", resp.status()));
    }

    let data: ExternalIdsResponse = resp.json().await.map_err(|e| format!("Parse error: {e}"))?;
    let doi = data.external_ids.and_then(|e| e.doi).filter(|d| !d.is_empty());
    Ok(doi)
}

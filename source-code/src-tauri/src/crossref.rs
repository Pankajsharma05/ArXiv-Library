use serde::{Deserialize, Serialize};

/// Citation metadata resolved from a DOI via Crossref.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Citation {
    pub doi: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i64>,
    pub container: Option<String>, // journal / venue
    pub volume: Option<String>,
    pub issue: Option<String>,
    pub page: Option<String>,
    pub publisher: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub url: Option<String>,
}

#[derive(Deserialize)]
struct CrossrefResponse {
    message: CrossrefMessage,
}

#[derive(Deserialize)]
struct CrossrefMessage {
    #[serde(rename = "DOI")]
    doi: Option<String>,
    title: Option<Vec<String>>,
    author: Option<Vec<CrossrefAuthor>>,
    #[serde(rename = "container-title")]
    container_title: Option<Vec<String>>,
    volume: Option<String>,
    issue: Option<String>,
    page: Option<String>,
    publisher: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(rename = "URL")]
    url: Option<String>,
    published: Option<CrossrefDate>,
    #[serde(rename = "published-print")]
    published_print: Option<CrossrefDate>,
    #[serde(rename = "published-online")]
    published_online: Option<CrossrefDate>,
}

#[derive(Deserialize)]
struct CrossrefAuthor {
    given: Option<String>,
    family: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct CrossrefDate {
    #[serde(rename = "date-parts")]
    date_parts: Option<Vec<Vec<i64>>>,
}

fn first_year(d: &Option<CrossrefDate>) -> Option<i64> {
    d.as_ref()
        .and_then(|x| x.date_parts.as_ref())
        .and_then(|p| p.first())
        .and_then(|p| p.first())
        .copied()
}

/// Normalize a DOI: strip URL prefixes and whitespace.
fn clean_doi(input: &str) -> String {
    let s = input.trim();
    let s = s.strip_prefix("https://doi.org/").unwrap_or(s);
    let s = s.strip_prefix("http://doi.org/").unwrap_or(s);
    let s = s.strip_prefix("https://dx.doi.org/").unwrap_or(s);
    let s = s.strip_prefix("http://dx.doi.org/").unwrap_or(s);
    let s = s.strip_prefix("doi:").or_else(|| s.strip_prefix("DOI:")).unwrap_or(s);
    s.trim().to_string()
}

pub async fn fetch_citation(doi_input: &str) -> Result<Citation, String> {
    let doi = clean_doi(doi_input);
    if doi.is_empty() {
        return Err("Empty DOI".to_string());
    }
    let url = format!("https://api.crossref.org/works/{doi}");
    // The shared client's User-Agent carries the project URL, which is what
    // Crossref's "polite pool" asks for.
    let resp = crate::http::API
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("No record found for DOI: {doi}"));
    }
    if !resp.status().is_success() {
        return Err(format!("Crossref returned HTTP {}", resp.status().as_u16()));
    }

    let data: CrossrefResponse = resp.json().await.map_err(|e| format!("Parse error: {e}"))?;
    let m = data.message;

    let authors = m.author.unwrap_or_default().into_iter().map(|a| {
        if let Some(name) = a.name {
            name
        } else {
            match (a.given, a.family) {
                (Some(g), Some(f)) => format!("{g} {f}"),
                (None, Some(f)) => f,
                (Some(g), None) => g,
                _ => String::new(),
            }
        }
    }).filter(|s| !s.is_empty()).collect();

    let year = first_year(&m.published)
        .or_else(|| first_year(&m.published_print))
        .or_else(|| first_year(&m.published_online));

    Ok(Citation {
        doi: m.doi.unwrap_or(doi),
        title: m.title.and_then(|t| t.into_iter().next()).unwrap_or_default(),
        authors,
        year,
        container: m.container_title.and_then(|c| c.into_iter().next()),
        volume: m.volume,
        issue: m.issue,
        page: m.page,
        publisher: m.publisher,
        kind: m.kind,
        url: m.url,
    })
}

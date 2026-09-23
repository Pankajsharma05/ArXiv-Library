use once_cell::sync::Lazy;
use std::time::Duration;

pub const USER_AGENT: &str =
    "ArxivLibrary/1.2 (+https://github.com/Pankajsharma05/ArXiv-Library; personal research tool)";

/// One connection-pooled client for all API calls. Building a fresh
/// `reqwest::Client` per request throws away keep-alive connections and TLS
/// sessions, and the default client has no timeout at all — a stalled server
/// would leave the UI spinning forever.
pub static API: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
        .expect("failed to build HTTP client")
});

/// PDFs can be large and arXiv sometimes serves them slowly, so this client only
/// bounds connection setup and idle reads, not the total transfer time.
pub static DOWNLOAD: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .expect("failed to build HTTP client")
});

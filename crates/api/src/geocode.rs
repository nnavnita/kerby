//! Geocoding proxy.
//!
//! The mobile app never talks to Google directly. This endpoint:
//!  * hides the API key on the server side,
//!  * caches results in Redis (both positive and negative — we never want to
//!    hit Google twice for the same query in 24h),
//!  * normalises the query so trivial whitespace/case differences collide on
//!    the same cache entry,
//!  * retries the upstream once on transient 5xx / network errors,
//!  * emits structured tracing so we can watch cache hit rate + upstream
//!    latency in production.
//!
//! Provider is Google Geocoding API today; swappable via [`Provider`].

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use tracing::instrument;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/geocode", get(search))
}

const CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const MIN_QUERY_LEN: usize = 3;
const MAX_QUERY_LEN: usize = 200;
const MAX_RESULTS: usize = 8;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(6);
const UPSTREAM_RETRY_BACKOFF: Duration = Duration::from_millis(200);
const AU_BOUNDS_MELBOURNE: &str = "-38.05,144.60|-37.55,145.30";

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GeocodeResult {
    pub label: String,
    pub lat: f64,
    pub lng: f64,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub results: Vec<GeocodeResult>,
    pub cached: bool,
}

/// Everything the handler needs to serve a request. Kept small so we can
/// swap providers later without touching handler code.
struct Provider<'a> {
    http: &'a reqwest::Client,
    api_key: &'a str,
}

#[instrument(skip(state, q), fields(query_len = q.q.len()))]
async fn search(
    State(state): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<SearchResponse>> {
    let normalised = normalise(&q.q);
    if normalised.len() < MIN_QUERY_LEN {
        return Ok(Json(SearchResponse {
            results: Vec::new(),
            cached: false,
        }));
    }
    if normalised.len() > MAX_QUERY_LEN {
        return Err(ApiError::BadRequest("query too long".into()));
    }

    let cache = cache_key(&normalised);

    // Cache lookup.
    let mut redis = state.redis.get_multiplexed_async_connection().await?;
    match redis.get::<_, Option<String>>(&cache).await {
        Ok(Some(cached)) => {
            if let Ok(results) = serde_json::from_str::<Vec<GeocodeResult>>(&cached) {
                tracing::debug!("geocode cache hit");
                return Ok(Json(SearchResponse {
                    results,
                    cached: true,
                }));
            }
            // Corrupted entry — drop it silently and refetch.
            let _: Result<(), _> = redis.del::<_, ()>(&cache).await;
        }
        Ok(None) => {}
        Err(e) => tracing::warn!(error = ?e, "geocode cache read failed"),
    }

    let api_key = state.google_maps_key.as_ref().ok_or_else(|| {
        ApiError::Internal("geocoding not configured (GOOGLE_MAPS_KEY missing)".into())
    })?;

    let provider = Provider {
        http: &state.http,
        api_key,
    };
    let results = provider.fetch(&normalised).await?;
    tracing::info!(count = results.len(), "geocode upstream fetched");

    // Persist to cache — both positive and empty results.
    if let Ok(serialised) = serde_json::to_string(&results) {
        if let Err(e) = redis
            .set_ex::<_, _, ()>(&cache, serialised, CACHE_TTL_SECS)
            .await
        {
            tracing::warn!(error = ?e, "geocode cache write failed");
        }
    }

    Ok(Json(SearchResponse {
        results,
        cached: false,
    }))
}

/// Lowercase + trim + collapse whitespace so `" 435  BOURKE  st "` and
/// `"435 bourke st"` share the same cache entry.
fn normalise(raw: &str) -> String {
    let trimmed = raw.trim();
    let mut out = String::with_capacity(trimmed.len());
    let mut prev_space = false;
    for ch in trimmed.chars() {
        if ch.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.extend(ch.to_lowercase());
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

fn cache_key(normalised: &str) -> String {
    let mut key = String::with_capacity(normalised.len() + 12);
    key.push_str("geocode:v1:");
    key.push_str(normalised);
    key
}

#[derive(Deserialize)]
struct GoogleResponse {
    status: String,
    #[serde(default)]
    error_message: Option<String>,
    #[serde(default)]
    results: Vec<GoogleResult>,
}

#[derive(Deserialize)]
struct GoogleResult {
    formatted_address: String,
    geometry: GoogleGeometry,
}

#[derive(Deserialize)]
struct GoogleGeometry {
    location: GoogleLocation,
}

#[derive(Deserialize)]
struct GoogleLocation {
    lat: f64,
    lng: f64,
}

impl Provider<'_> {
    async fn fetch(&self, query: &str) -> ApiResult<Vec<GeocodeResult>> {
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let started = std::time::Instant::now();
            let result = self.fetch_once(query).await;
            let elapsed_ms = started.elapsed().as_millis();
            match result {
                Ok(rows) => {
                    tracing::debug!(elapsed_ms, attempt, "geocode upstream ok");
                    return Ok(rows);
                }
                Err(err) if err.retryable() && attempt < 2 => {
                    tracing::warn!(?err, elapsed_ms, attempt, "geocode upstream transient");
                    tokio::time::sleep(UPSTREAM_RETRY_BACKOFF).await;
                }
                Err(err) => {
                    tracing::error!(?err, elapsed_ms, attempt, "geocode upstream final");
                    return Err(err.into());
                }
            }
        }
    }

    async fn fetch_once(&self, query: &str) -> Result<Vec<GeocodeResult>, UpstreamError> {
        let resp = self
            .http
            .get("https://maps.googleapis.com/maps/api/geocode/json")
            .query(&[
                ("key", self.api_key),
                ("address", query),
                ("region", "au"),
                ("bounds", AU_BOUNDS_MELBOURNE),
            ])
            .timeout(UPSTREAM_TIMEOUT)
            .send()
            .await
            .map_err(UpstreamError::Network)?;

        let status = resp.status();
        if status.is_server_error() {
            return Err(UpstreamError::UpstreamStatus(status));
        }
        if !status.is_success() {
            return Err(UpstreamError::UpstreamStatus(status));
        }

        let body: GoogleResponse = resp.json().await.map_err(UpstreamError::Decode)?;
        match body.status.as_str() {
            "OK" | "ZERO_RESULTS" => {}
            "OVER_QUERY_LIMIT" | "OVER_DAILY_LIMIT" | "RESOURCE_EXHAUSTED" => {
                return Err(UpstreamError::RateLimited);
            }
            "REQUEST_DENIED" => {
                return Err(UpstreamError::Configuration(
                    body.error_message.unwrap_or_default(),
                ));
            }
            other => {
                return Err(UpstreamError::UnexpectedStatus(
                    other.to_string(),
                    body.error_message.unwrap_or_default(),
                ));
            }
        }

        let mut out = Vec::with_capacity(MAX_RESULTS);
        for r in body.results.into_iter().take(MAX_RESULTS) {
            out.push(GeocodeResult {
                label: r.formatted_address,
                lat: r.geometry.location.lat,
                lng: r.geometry.location.lng,
            });
        }
        Ok(out)
    }
}

/// Precise upstream error variants; the transport layer decides which map
/// to a retry vs a client-visible error.
#[derive(Debug)]
enum UpstreamError {
    Network(reqwest::Error),
    UpstreamStatus(reqwest::StatusCode),
    Decode(reqwest::Error),
    RateLimited,
    Configuration(String),
    UnexpectedStatus(String, String),
}

impl UpstreamError {
    fn retryable(&self) -> bool {
        match self {
            UpstreamError::Network(e) => e.is_timeout() || e.is_connect() || e.is_request(),
            UpstreamError::UpstreamStatus(s) => s.is_server_error(),
            _ => false,
        }
    }
}

impl From<UpstreamError> for ApiError {
    fn from(e: UpstreamError) -> Self {
        match e {
            UpstreamError::Network(err) => ApiError::Internal(format!("geocode network: {err}")),
            UpstreamError::UpstreamStatus(s) => {
                ApiError::Internal(format!("geocode upstream status {s}"))
            }
            UpstreamError::Decode(err) => ApiError::Internal(format!("geocode decode: {err}")),
            UpstreamError::RateLimited => {
                ApiError::Internal("geocode upstream rate limited".into())
            }
            UpstreamError::Configuration(msg) => {
                ApiError::Internal(format!("geocode key misconfigured: {msg}"))
            }
            UpstreamError::UnexpectedStatus(status, msg) => {
                ApiError::Internal(format!("geocode upstream {status}: {msg}"))
            }
        }
    }
}

// Marker to allow the module's internal Arc-key type to be shared even
// though it's not surfaced in the response DTO.
#[allow(dead_code)]
type ApiKey = Arc<String>;

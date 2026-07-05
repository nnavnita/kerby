//! Directions proxy.
//!
//! Wraps Google Directions API so the mobile client doesn't need the API
//! key and to keep upstream fanout bounded. Response is normalised into the
//! minimal shape the client renders: encoded overview polyline, per-step
//! instructions with start/end coordinates, plus totals. Cached briefly
//! (5 min) because traffic drifts and users doing WS-driven reroutes need
//! fresh data.

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
    Router::new().route("/directions", get(directions))
}

const CACHE_TTL_SECS: u64 = 5 * 60;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(6);
const UPSTREAM_RETRY_BACKOFF: Duration = Duration::from_millis(200);
const ALLOWED_MODES: &[&str] = &["driving", "walking", "bicycling", "transit"];

#[derive(Deserialize)]
pub struct DirectionsQuery {
    origin: String,
    destination: String,
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LatLng {
    pub lat: f64,
    pub lng: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Step {
    pub instruction: String,
    pub distance_m: i32,
    pub duration_s: i32,
    pub start: LatLng,
    pub end: LatLng,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maneuver: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DirectionsResponse {
    pub polyline: String,
    pub distance_m: i32,
    pub duration_s: i32,
    pub steps: Vec<Step>,
    pub cached: bool,
}

#[instrument(skip(state, q), fields(origin = %q.origin, destination = %q.destination))]
async fn directions(
    State(state): State<AppState>,
    Query(q): Query<DirectionsQuery>,
) -> ApiResult<Json<DirectionsResponse>> {
    let (o_lat, o_lng) = parse_ll(&q.origin)?;
    let (d_lat, d_lng) = parse_ll(&q.destination)?;
    let mode = q.mode.as_deref().unwrap_or("driving").trim().to_string();
    if !ALLOWED_MODES.contains(&mode.as_str()) {
        return Err(ApiError::BadRequest("invalid mode".into()));
    }
    let origin = format!("{o_lat},{o_lng}");
    let destination = format!("{d_lat},{d_lng}");
    let cache = format!("dir:v1:{mode}:{origin}:{destination}");

    let mut redis = state.redis.get_multiplexed_async_connection().await?;
    if let Ok(Some(cached)) = redis.get::<_, Option<String>>(&cache).await {
        if let Ok(mut r) = serde_json::from_str::<DirectionsResponse>(&cached) {
            r.cached = true;
            tracing::debug!("directions cache hit");
            return Ok(Json(r));
        }
        let _: Result<(), _> = redis.del::<_, ()>(&cache).await;
    }

    let api_key = state
        .google_maps_key
        .as_ref()
        .ok_or_else(|| ApiError::Internal("directions not configured".into()))?;

    let result = fetch_google(&state.http, api_key, &origin, &destination, &mode).await?;

    if let Ok(s) = serde_json::to_string(&result) {
        if let Err(e) = redis.set_ex::<_, _, ()>(&cache, s, CACHE_TTL_SECS).await {
            tracing::warn!(error = ?e, "directions cache write failed");
        }
    }

    Ok(Json(result))
}

fn parse_ll(raw: &str) -> ApiResult<(f64, f64)> {
    let mut parts = raw.splitn(2, ',');
    let lat = parts
        .next()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .ok_or_else(|| ApiError::BadRequest("bad lat/lng".into()))?;
    let lng = parts
        .next()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .ok_or_else(|| ApiError::BadRequest("bad lat/lng".into()))?;
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lng) {
        return Err(ApiError::BadRequest("lat/lng out of range".into()));
    }
    Ok((lat, lng))
}

#[derive(Deserialize)]
struct GResp {
    status: String,
    #[serde(default)]
    error_message: Option<String>,
    #[serde(default)]
    routes: Vec<GRoute>,
}

#[derive(Deserialize)]
struct GRoute {
    overview_polyline: GPoly,
    legs: Vec<GLeg>,
}

#[derive(Deserialize)]
struct GPoly {
    points: String,
}

#[derive(Deserialize)]
struct GLeg {
    distance: GVal,
    duration: GVal,
    steps: Vec<GStep>,
}

#[derive(Deserialize)]
struct GVal {
    value: i32,
}

#[derive(Deserialize)]
struct GStep {
    html_instructions: String,
    distance: GVal,
    duration: GVal,
    start_location: GLoc,
    end_location: GLoc,
    #[serde(default)]
    maneuver: Option<String>,
}

#[derive(Deserialize)]
struct GLoc {
    lat: f64,
    lng: f64,
}

async fn fetch_google(
    http: &reqwest::Client,
    api_key: &str,
    origin: &str,
    destination: &str,
    mode: &str,
) -> ApiResult<DirectionsResponse> {
    for attempt in 1..=2u32 {
        match fetch_google_once(http, api_key, origin, destination, mode).await {
            Ok(v) => return Ok(v),
            Err(e) if e.retryable() && attempt == 1 => {
                tracing::warn!(?e, "directions transient, retrying");
                tokio::time::sleep(UPSTREAM_RETRY_BACKOFF).await;
            }
            Err(e) => return Err(e.into()),
        }
    }
    unreachable!()
}

async fn fetch_google_once(
    http: &reqwest::Client,
    api_key: &str,
    origin: &str,
    destination: &str,
    mode: &str,
) -> Result<DirectionsResponse, UpstreamError> {
    let resp = http
        .get("https://maps.googleapis.com/maps/api/directions/json")
        .query(&[
            ("key", api_key),
            ("origin", origin),
            ("destination", destination),
            ("mode", mode),
            ("region", "au"),
        ])
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(UpstreamError::Network)?;

    let status = resp.status();
    if !status.is_success() {
        return Err(UpstreamError::Status(status));
    }

    let body: GResp = resp.json().await.map_err(UpstreamError::Decode)?;
    match body.status.as_str() {
        "OK" => {}
        "ZERO_RESULTS" => {
            return Err(UpstreamError::NoRoute);
        }
        "OVER_QUERY_LIMIT" | "OVER_DAILY_LIMIT" | "RESOURCE_EXHAUSTED" => {
            return Err(UpstreamError::RateLimited);
        }
        "REQUEST_DENIED" => {
            return Err(UpstreamError::Configuration(
                body.error_message.unwrap_or_default(),
            ));
        }
        other => {
            return Err(UpstreamError::Unexpected(
                other.into(),
                body.error_message.unwrap_or_default(),
            ))
        }
    }

    let route = body
        .routes
        .into_iter()
        .next()
        .ok_or(UpstreamError::NoRoute)?;
    let leg = route
        .legs
        .into_iter()
        .next()
        .ok_or(UpstreamError::NoRoute)?;

    let steps = leg
        .steps
        .into_iter()
        .map(|s| Step {
            instruction: strip_html(&s.html_instructions),
            distance_m: s.distance.value,
            duration_s: s.duration.value,
            start: LatLng {
                lat: s.start_location.lat,
                lng: s.start_location.lng,
            },
            end: LatLng {
                lat: s.end_location.lat,
                lng: s.end_location.lng,
            },
            maneuver: s.maneuver,
        })
        .collect();

    Ok(DirectionsResponse {
        polyline: route.overview_polyline.points,
        distance_m: leg.distance.value,
        duration_s: leg.duration.value,
        steps,
        cached: false,
    })
}

#[derive(Debug)]
enum UpstreamError {
    Network(reqwest::Error),
    Status(reqwest::StatusCode),
    Decode(reqwest::Error),
    NoRoute,
    RateLimited,
    Configuration(String),
    Unexpected(String, String),
}

impl UpstreamError {
    fn retryable(&self) -> bool {
        match self {
            UpstreamError::Network(e) => e.is_timeout() || e.is_connect() || e.is_request(),
            UpstreamError::Status(s) => s.is_server_error(),
            _ => false,
        }
    }
}

impl From<UpstreamError> for ApiError {
    fn from(e: UpstreamError) -> Self {
        match e {
            UpstreamError::Network(err) => ApiError::Internal(format!("directions net: {err}")),
            UpstreamError::Status(s) => ApiError::Internal(format!("directions upstream {s}")),
            UpstreamError::Decode(err) => ApiError::Internal(format!("directions decode: {err}")),
            UpstreamError::NoRoute => ApiError::BadRequest("no route between those points".into()),
            UpstreamError::RateLimited => ApiError::Internal("directions rate limited".into()),
            UpstreamError::Configuration(msg) => {
                ApiError::Internal(format!("directions key misconfigured: {msg}"))
            }
            UpstreamError::Unexpected(status, msg) => {
                ApiError::Internal(format!("directions {status}: {msg}"))
            }
        }
    }
}

/// Strip HTML tags and decode the small handful of entities Google returns
/// in `html_instructions`.
fn strip_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

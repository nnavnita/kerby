use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::optional_auth_user;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/bays/near", get(near))
}

const DEFAULT_RADIUS_M: i32 = 500;
const MAX_RADIUS_M: i32 = 2_000;
const DEFAULT_LIMIT: i32 = 200;
const MAX_LIMIT: i32 = 500;
const DEFAULT_MAX_STALE_SECS: i64 = 2 * 60 * 60;

#[derive(Deserialize)]
pub struct NearQuery {
    lat: f64,
    lng: f64,
    #[serde(default)]
    radius_m: Option<i32>,
    #[serde(default)]
    limit: Option<i32>,
    /// Only return bays whose sensor says unoccupied AND is fresh.
    #[serde(default)]
    available_only: Option<bool>,
    /// Sensor readings older than this treated as stale (default 2h).
    #[serde(default)]
    max_stale_secs: Option<i64>,
    /// Include bays without any sensor coverage.
    #[serde(default)]
    include_no_sensor: Option<bool>,
}

#[derive(Serialize)]
pub struct SensorInfo {
    pub status: String,
    pub source_updated_at: Option<DateTime<Utc>>,
    pub fetched_at: Option<DateTime<Utc>>,
    pub fresh: bool,
    pub age_secs: Option<i64>,
}

#[derive(Serialize)]
pub struct LockInfo {
    pub expires_at: DateTime<Utc>,
    pub mine: bool,
}

#[derive(Serialize)]
pub struct BayNear {
    pub id: String,
    pub lat: f64,
    pub lng: f64,
    pub street: Option<String>,
    pub distance_m: i32,
    pub sensor: Option<SensorInfo>,
    pub lock: Option<LockInfo>,
}

#[derive(Serialize)]
pub struct NearResponse {
    pub count: usize,
    pub generated_at: DateTime<Utc>,
    pub bays: Vec<BayNear>,
}

#[derive(Deserialize)]
struct SensorPayload {
    status: String,
    source_updated_at: DateTime<Utc>,
    fetched_at: DateTime<Utc>,
}

async fn near(
    State(state): State<AppState>,
    caller: Option<crate::auth::AuthUser>,
    Query(q): Query<NearQuery>,
) -> ApiResult<Json<NearResponse>> {
    let caller_id: Option<Uuid> = caller.map(|c| c.0);
    let _ = optional_auth_user; // keep helper referenced

    if !(-90.0..=90.0).contains(&q.lat) || !(-180.0..=180.0).contains(&q.lng) {
        return Err(ApiError::BadRequest("lat/lng out of range".into()));
    }
    let radius_m = q
        .radius_m
        .unwrap_or(DEFAULT_RADIUS_M)
        .clamp(1, MAX_RADIUS_M);
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let max_stale = q.max_stale_secs.unwrap_or(DEFAULT_MAX_STALE_SECS).max(0);
    let available_only = q.available_only.unwrap_or(false);
    let include_no_sensor = q.include_no_sensor.unwrap_or(true);

    let rows: Vec<(String, f64, f64, Option<String>, f64)> = sqlx::query_as(
        r#"
        SELECT
            id,
            ST_X(centroid::geometry) AS lng,
            ST_Y(centroid::geometry) AS lat,
            street_name,
            ST_DistanceSphere(centroid::geometry, ST_MakePoint($1, $2)) AS distance_m
        FROM bays
        WHERE ST_DWithin(centroid, ST_MakePoint($1, $2)::geography, $3::float8)
        ORDER BY centroid <-> ST_MakePoint($1, $2)::geography
        LIMIT $4
        "#,
    )
    .bind(q.lng)
    .bind(q.lat)
    .bind(radius_m as f64)
    .bind(limit as i64)
    .fetch_all(&state.db)
    .await?;

    // Look up sensor status for these ids in Redis.
    let keys: Vec<String> = rows.iter().map(|r| format!("bay:{}:status", r.0)).collect();
    let sensor_values: Vec<Option<String>> = if keys.is_empty() {
        Vec::new()
    } else {
        let mut conn = state.redis.get_multiplexed_async_connection().await?;
        conn.mget(&keys).await?
    };

    // Active locks for these bays.
    let bay_ids: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let lock_rows: Vec<(String, Uuid, DateTime<Utc>)> = if bay_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            r#"
            SELECT bay_id, user_id, expires_at
            FROM locks
            WHERE bay_id = ANY($1)
              AND released_at IS NULL
              AND expires_at > now()
            "#,
        )
        .bind(&bay_ids)
        .fetch_all(&state.db)
        .await?
    };
    let locks_by_bay: HashMap<String, (Uuid, DateTime<Utc>)> = lock_rows
        .into_iter()
        .map(|(bay_id, uid, exp)| (bay_id, (uid, exp)))
        .collect();

    let now = Utc::now();
    let mut bays = Vec::with_capacity(rows.len());
    for (i, (id, lng, lat, street, distance_m)) in rows.into_iter().enumerate() {
        let sensor = sensor_values
            .get(i)
            .and_then(|v| v.as_deref())
            .and_then(|s| serde_json::from_str::<SensorPayload>(s).ok())
            .map(|p| {
                let age_secs = (now - p.source_updated_at).num_seconds();
                let fresh = age_secs >= 0 && age_secs <= max_stale;
                SensorInfo {
                    status: p.status,
                    source_updated_at: Some(p.source_updated_at),
                    fetched_at: Some(p.fetched_at),
                    fresh,
                    age_secs: Some(age_secs),
                }
            });

        let lock = locks_by_bay.get(&id).map(|(uid, expires_at)| LockInfo {
            expires_at: *expires_at,
            mine: caller_id == Some(*uid),
        });

        // Filter rules.
        if !include_no_sensor && sensor.is_none() {
            continue;
        }
        if available_only {
            let unoccupied_ok = matches!(&sensor, Some(s) if s.fresh && s.status == "unoccupied");
            let lock_ok = lock.as_ref().map(|l| l.mine).unwrap_or(true);
            if !unoccupied_ok || !lock_ok {
                continue;
            }
        }

        bays.push(BayNear {
            id,
            lat,
            lng,
            street,
            distance_m: distance_m.round() as i32,
            sensor,
            lock,
        });
    }

    Ok(Json(NearResponse {
        count: bays.len(),
        generated_at: now,
        bays,
    }))
}

use axum::extract::{Path, State};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/locks", post(create))
        .route("/locks/current", get(current))
        .route("/locks/:id", delete(release))
        .route("/locks/:id/extend", post(extend))
}

const LOCK_DURATION_SECS: i64 = 15 * 60;
const LOCK_EXTEND_SECS: i64 = 10 * 60;
const LOCK_EXTEND_MAX_DISTANCE_M: f64 = 500.0;

#[derive(Deserialize)]
pub struct CreateRequest {
    pub bay_id: String,
}

#[derive(Deserialize)]
pub struct ExtendRequest {
    pub lat: f64,
    pub lng: f64,
}

#[derive(Serialize)]
pub struct LockDto {
    pub id: Uuid,
    pub bay_id: String,
    pub user_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub released_at: Option<DateTime<Utc>>,
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Json(req): Json<CreateRequest>,
) -> ApiResult<Json<LockDto>> {
    let expires_at = Utc::now() + Duration::seconds(LOCK_DURATION_SECS);
    let result: Result<(Uuid, String, Uuid, DateTime<Utc>, DateTime<Utc>), sqlx::Error> =
        sqlx::query_as(
            r#"
        INSERT INTO locks (user_id, bay_id, expires_at)
        VALUES ($1, $2, $3)
        RETURNING id, bay_id, user_id, created_at, expires_at
        "#,
        )
        .bind(user_id)
        .bind(&req.bay_id)
        .bind(expires_at)
        .fetch_one(&state.db)
        .await;

    match result {
        Ok((id, bay_id, user_id, created_at, expires_at)) => Ok(Json(LockDto {
            id,
            bay_id,
            user_id,
            created_at,
            expires_at,
            released_at: None,
        })),
        Err(sqlx::Error::Database(db)) => {
            let msg = match db.constraint() {
                Some("locks_active_per_user") => "you already hold a lock; release it first",
                Some("locks_active_per_bay") => "this bay is already locked by someone",
                _ => "conflict",
            };
            Err(ApiError::Conflict(msg.into()))
        }
        Err(e) => Err(e.into()),
    }
}

async fn release(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<LockDto>> {
    let row: Option<(
        Uuid,
        String,
        Uuid,
        DateTime<Utc>,
        DateTime<Utc>,
        DateTime<Utc>,
    )> = sqlx::query_as(
        r#"
            UPDATE locks
            SET released_at = now(), release_reason = 'cancelled'
            WHERE id = $1 AND user_id = $2 AND released_at IS NULL
            RETURNING id, bay_id, user_id, created_at, expires_at, released_at
            "#,
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let (id, bay_id, user_id, created_at, expires_at, released_at) =
        row.ok_or(ApiError::NotFound)?;
    Ok(Json(LockDto {
        id,
        bay_id,
        user_id,
        created_at,
        expires_at,
        released_at: Some(released_at),
    }))
}

async fn extend(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<ExtendRequest>,
) -> ApiResult<Json<LockDto>> {
    if !(-90.0..=90.0).contains(&req.lat) || !(-180.0..=180.0).contains(&req.lng) {
        return Err(ApiError::BadRequest("lat/lng out of range".into()));
    }

    // Verify the caller is within LOCK_EXTEND_MAX_DISTANCE_M of the locked bay.
    let distance: Option<(f64,)> = sqlx::query_as(
        r#"
        SELECT ST_DistanceSphere(b.centroid::geometry, ST_MakePoint($1, $2))
        FROM locks l
        JOIN bays b ON b.id = l.bay_id
        WHERE l.id = $3 AND l.user_id = $4 AND l.released_at IS NULL
        "#,
    )
    .bind(req.lng)
    .bind(req.lat)
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let (dist_m,) = distance.ok_or(ApiError::NotFound)?;
    if dist_m > LOCK_EXTEND_MAX_DISTANCE_M {
        return Err(ApiError::BadRequest(format!(
            "too far to extend: {}m from bay",
            dist_m.round() as i64
        )));
    }

    let new_expiry = Utc::now() + Duration::seconds(LOCK_EXTEND_SECS);
    let row: Option<(Uuid, String, Uuid, DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
        r#"
        UPDATE locks
        SET expires_at = GREATEST(expires_at, $1)
        WHERE id = $2 AND user_id = $3 AND released_at IS NULL
        RETURNING id, bay_id, user_id, created_at, expires_at
        "#,
    )
    .bind(new_expiry)
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let (id, bay_id, user_id, created_at, expires_at) = row.ok_or(ApiError::NotFound)?;
    Ok(Json(LockDto {
        id,
        bay_id,
        user_id,
        created_at,
        expires_at,
        released_at: None,
    }))
}

async fn current(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
) -> ApiResult<Json<Option<LockDto>>> {
    let row: Option<(Uuid, String, Uuid, DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
        r#"
        SELECT id, bay_id, user_id, created_at, expires_at
        FROM locks
        WHERE user_id = $1 AND released_at IS NULL AND expires_at > now()
        "#,
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(row.map(
        |(id, bay_id, user_id, created_at, expires_at)| LockDto {
            id,
            bay_id,
            user_id,
            created_at,
            expires_at,
            released_at: None,
        },
    )))
}

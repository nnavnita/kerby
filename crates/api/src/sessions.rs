use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/sessions", post(create))
        .route("/sessions/current", get(current))
        .route("/sessions/:id/return", post(mark_returned))
}

#[derive(Deserialize)]
pub struct CreateRequest {
    #[serde(default)]
    pub bay_id: Option<String>,
    pub lat: f64,
    pub lng: f64,
    #[serde(default)]
    pub photo_url: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Serialize)]
pub struct SessionDto {
    pub id: Uuid,
    pub bay_id: Option<String>,
    pub lat: f64,
    pub lng: f64,
    pub photo_url: Option<String>,
    pub note: Option<String>,
    pub parked_at: DateTime<Utc>,
    pub returned_at: Option<DateTime<Utc>>,
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Json(req): Json<CreateRequest>,
) -> ApiResult<Json<SessionDto>> {
    if !(-90.0..=90.0).contains(&req.lat) || !(-180.0..=180.0).contains(&req.lng) {
        return Err(ApiError::BadRequest("lat/lng out of range".into()));
    }

    let result: Result<
        (
            Uuid,
            Option<String>,
            f64,
            f64,
            Option<String>,
            Option<String>,
            DateTime<Utc>,
        ),
        sqlx::Error,
    > = sqlx::query_as(
        r#"
        INSERT INTO parked_sessions (user_id, bay_id, parked_at_geo, photo_url, note)
        VALUES ($1, $2, ST_MakePoint($3, $4)::geography, $5, $6)
        RETURNING
            id,
            bay_id,
            ST_X(parked_at_geo::geometry) AS lng,
            ST_Y(parked_at_geo::geometry) AS lat,
            photo_url,
            note,
            parked_at
        "#,
    )
    .bind(user_id)
    .bind(&req.bay_id)
    .bind(req.lng)
    .bind(req.lat)
    .bind(&req.photo_url)
    .bind(&req.note)
    .fetch_one(&state.db)
    .await;

    match result {
        Ok((id, bay_id, lng, lat, photo_url, note, parked_at)) => Ok(Json(SessionDto {
            id,
            bay_id,
            lat,
            lng,
            photo_url,
            note,
            parked_at,
            returned_at: None,
        })),
        Err(sqlx::Error::Database(db))
            if db.constraint() == Some("parked_sessions_active_per_user") =>
        {
            Err(ApiError::Conflict(
                "you already have an active parked session; return it first".into(),
            ))
        }
        Err(e) => Err(e.into()),
    }
}

async fn current(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
) -> ApiResult<Json<Option<SessionDto>>> {
    let row: Option<(
        Uuid,
        Option<String>,
        f64,
        f64,
        Option<String>,
        Option<String>,
        DateTime<Utc>,
    )> = sqlx::query_as(
        r#"
        SELECT
            id,
            bay_id,
            ST_X(parked_at_geo::geometry) AS lng,
            ST_Y(parked_at_geo::geometry) AS lat,
            photo_url,
            note,
            parked_at
        FROM parked_sessions
        WHERE user_id = $1 AND returned_at IS NULL
        "#,
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    Ok(Json(row.map(
        |(id, bay_id, lng, lat, photo_url, note, parked_at)| SessionDto {
            id,
            bay_id,
            lat,
            lng,
            photo_url,
            note,
            parked_at,
            returned_at: None,
        },
    )))
}

async fn mark_returned(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<SessionDto>> {
    let row: Option<(
        Uuid,
        Option<String>,
        f64,
        f64,
        Option<String>,
        Option<String>,
        DateTime<Utc>,
        DateTime<Utc>,
    )> = sqlx::query_as(
        r#"
        UPDATE parked_sessions
        SET returned_at = now()
        WHERE id = $1 AND user_id = $2 AND returned_at IS NULL
        RETURNING
            id,
            bay_id,
            ST_X(parked_at_geo::geometry) AS lng,
            ST_Y(parked_at_geo::geometry) AS lat,
            photo_url,
            note,
            parked_at,
            returned_at
        "#,
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let (id, bay_id, lng, lat, photo_url, note, parked_at, returned_at) =
        row.ok_or(ApiError::NotFound)?;
    Ok(Json(SessionDto {
        id,
        bay_id,
        lat,
        lng,
        photo_url,
        note,
        parked_at,
        returned_at: Some(returned_at),
    }))
}

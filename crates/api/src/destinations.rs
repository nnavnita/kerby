use axum::extract::{Path, State};
use axum::routing::{delete, get};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/destinations", get(list).post(create))
        .route("/destinations/:id", delete(destroy).put(update))
}

#[derive(Deserialize)]
pub struct SaveRequest {
    pub name: String,
    pub lat: f64,
    pub lng: f64,
    #[serde(default)]
    pub walk_radius_m: Option<i32>,
    #[serde(default)]
    pub available_only: Option<bool>,
}

#[derive(Serialize)]
pub struct DestinationDto {
    pub id: Uuid,
    pub name: String,
    pub lat: f64,
    pub lng: f64,
    pub walk_radius_m: i32,
    pub available_only: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

async fn list(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
) -> ApiResult<Json<Vec<DestinationDto>>> {
    let rows: Vec<(
        Uuid,
        String,
        f64,
        f64,
        i32,
        bool,
        DateTime<Utc>,
        DateTime<Utc>,
    )> = sqlx::query_as(
        r#"
            SELECT id, name,
                   ST_X(location::geometry) AS lng,
                   ST_Y(location::geometry) AS lat,
                   walk_radius_m, available_only, created_at, updated_at
            FROM saved_destinations
            WHERE user_id = $1
            ORDER BY created_at DESC
            "#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|(id, name, lng, lat, r, avail, c, u)| DestinationDto {
                id,
                name,
                lat,
                lng,
                walk_radius_m: r,
                available_only: avail,
                created_at: c,
                updated_at: u,
            })
            .collect(),
    ))
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Json(req): Json<SaveRequest>,
) -> ApiResult<Json<DestinationDto>> {
    validate(&req)?;
    let (id, name, lng, lat, r, avail, c, u): (
        Uuid,
        String,
        f64,
        f64,
        i32,
        bool,
        DateTime<Utc>,
        DateTime<Utc>,
    ) = sqlx::query_as(
        r#"
        INSERT INTO saved_destinations
            (user_id, name, location, walk_radius_m, available_only)
        VALUES ($1, $2, ST_MakePoint($3, $4)::geography,
                COALESCE($5, 300), COALESCE($6, true))
        RETURNING id, name,
                  ST_X(location::geometry) AS lng,
                  ST_Y(location::geometry) AS lat,
                  walk_radius_m, available_only, created_at, updated_at
        "#,
    )
    .bind(user_id)
    .bind(req.name.trim())
    .bind(req.lng)
    .bind(req.lat)
    .bind(req.walk_radius_m)
    .bind(req.available_only)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(DestinationDto {
        id,
        name,
        lat,
        lng,
        walk_radius_m: r,
        available_only: avail,
        created_at: c,
        updated_at: u,
    }))
}

async fn update(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<SaveRequest>,
) -> ApiResult<Json<DestinationDto>> {
    validate(&req)?;
    let row: Option<(
        Uuid,
        String,
        f64,
        f64,
        i32,
        bool,
        DateTime<Utc>,
        DateTime<Utc>,
    )> = sqlx::query_as(
        r#"
            UPDATE saved_destinations SET
                name = $1,
                location = ST_MakePoint($2, $3)::geography,
                walk_radius_m = COALESCE($4, walk_radius_m),
                available_only = COALESCE($5, available_only),
                updated_at = now()
            WHERE id = $6 AND user_id = $7
            RETURNING id, name,
                      ST_X(location::geometry) AS lng,
                      ST_Y(location::geometry) AS lat,
                      walk_radius_m, available_only, created_at, updated_at
            "#,
    )
    .bind(req.name.trim())
    .bind(req.lng)
    .bind(req.lat)
    .bind(req.walk_radius_m)
    .bind(req.available_only)
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let (id, name, lng, lat, r, avail, c, u) = row.ok_or(ApiError::NotFound)?;
    Ok(Json(DestinationDto {
        id,
        name,
        lat,
        lng,
        walk_radius_m: r,
        available_only: avail,
        created_at: c,
        updated_at: u,
    }))
}

async fn destroy(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    let n = sqlx::query("DELETE FROM saved_destinations WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(&state.db)
        .await?
        .rows_affected();

    if n == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn validate(req: &SaveRequest) -> ApiResult<()> {
    if req.name.trim().is_empty() {
        return Err(ApiError::BadRequest("name required".into()));
    }
    if !(-90.0..=90.0).contains(&req.lat) || !(-180.0..=180.0).contains(&req.lng) {
        return Err(ApiError::BadRequest("lat/lng out of range".into()));
    }
    if let Some(r) = req.walk_radius_m {
        if !(50..=2000).contains(&r) {
            return Err(ApiError::BadRequest(
                "walk_radius_m must be 50..2000".into(),
            ));
        }
    }
    Ok(())
}

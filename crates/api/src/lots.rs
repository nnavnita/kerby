use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/lots/near", get(near))
}

#[derive(Deserialize)]
pub struct NearQuery {
    lat: f64,
    lng: f64,
    #[serde(default)]
    radius_m: Option<i32>,
    #[serde(default)]
    limit: Option<i32>,
}

#[derive(Serialize)]
pub struct LotDto {
    pub id: String,
    pub name: Option<String>,
    pub operator: Option<String>,
    pub lot_type: Option<String>,
    pub capacity: Option<i32>,
    pub lat: f64,
    pub lng: f64,
    pub distance_m: i32,
}

async fn near(
    State(state): State<AppState>,
    Query(q): Query<NearQuery>,
) -> ApiResult<Json<Vec<LotDto>>> {
    if !(-90.0..=90.0).contains(&q.lat) || !(-180.0..=180.0).contains(&q.lng) {
        return Err(ApiError::BadRequest("lat/lng out of range".into()));
    }
    let radius = q.radius_m.unwrap_or(500).clamp(1, 5_000);
    let limit = q.limit.unwrap_or(50).clamp(1, 200);

    let rows: Vec<(
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i32>,
        f64,
        f64,
        f64,
    )> = sqlx::query_as(
        r#"
        SELECT id, name, operator, lot_type, capacity,
               ST_X(location::geometry) AS lng,
               ST_Y(location::geometry) AS lat,
               ST_DistanceSphere(location::geometry, ST_MakePoint($1, $2)) AS distance_m
        FROM off_street_lots
        WHERE ST_DWithin(location, ST_MakePoint($1, $2)::geography, $3::float8)
        ORDER BY location <-> ST_MakePoint($1, $2)::geography
        LIMIT $4
        "#,
    )
    .bind(q.lng)
    .bind(q.lat)
    .bind(radius as f64)
    .bind(limit as i64)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(
                |(id, name, operator, lot_type, capacity, lng, lat, dist)| LotDto {
                    id,
                    name,
                    operator,
                    lot_type,
                    capacity,
                    lat,
                    lng,
                    distance_m: dist.round() as i32,
                },
            )
            .collect(),
    ))
}

// sqlx::query_as tuples are intentionally verbose — they mirror the SELECT list.
// Extracting a `type` alias per query hurts readability more than it helps.
#![allow(clippy::type_complexity)]

pub mod auth;
pub mod bays;
pub mod destinations;
pub mod directions;
pub mod error;
pub mod geocode;
pub mod legal;
pub mod live;
pub mod locks;
pub mod lots;
pub mod sessions;
pub mod share;
pub mod state;
pub mod tokens;
pub mod users;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use tower::ServiceBuilder;
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::GovernorLayer;
use tower_http::cors::CorsLayer;
use tower_http::request_id::{
    MakeRequestUuid, PropagateRequestIdLayer, RequestId, SetRequestIdLayer,
};
use tower_http::trace::{DefaultOnResponse, TraceLayer};
use tracing::Level;

pub use state::AppState;

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let db_ok = sqlx::query("SELECT 1").execute(&state.db).await.is_ok();
    let redis_ok = match state.redis.get_multiplexed_async_connection().await {
        Ok(mut conn) => redis::cmd("PING")
            .query_async::<String>(&mut conn)
            .await
            .is_ok(),
        Err(_) => false,
    };
    let status = if db_ok && redis_ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(json!({ "db": db_ok, "redis": redis_ok })))
}

fn request_id_header(request_id: Option<&RequestId>) -> String {
    request_id
        .and_then(|id| id.header_value().to_str().ok())
        .unwrap_or_default()
        .to_string()
}

/// Access token TTL. Short-lived by design — session continuity comes from
/// the refresh token (see `auth.rs`), not from a long-lived JWT.
pub const DEFAULT_ACCESS_TOKEN_TTL_SECS: i64 = 15 * 60;

pub fn build_router(state: AppState, with_rate_limit: bool) -> Router {
    let mut public_read = Router::new()
        .merge(bays::routes())
        .merge(lots::routes())
        .merge(share::routes())
        .merge(geocode::routes())
        .merge(directions::routes());
    let mut auth_gated = Router::new().merge(auth::routes());

    if with_rate_limit {
        let public_gov = Arc::new(
            GovernorConfigBuilder::default()
                .per_second(1)
                .burst_size(30)
                .finish()
                .expect("governor config"),
        );
        let auth_gov = Arc::new(
            GovernorConfigBuilder::default()
                .per_second(1)
                .burst_size(10)
                .finish()
                .expect("governor config"),
        );

        let cleanup_public = public_gov.clone();
        let cleanup_auth = auth_gov.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(60));
            loop {
                ticker.tick().await;
                cleanup_public.limiter().retain_recent();
                cleanup_auth.limiter().retain_recent();
            }
        });

        public_read = public_read.layer(GovernorLayer { config: public_gov });
        auth_gated = auth_gated.layer(GovernorLayer { config: auth_gov });
    }

    Router::new()
        .route("/health", get(health))
        .merge(auth_gated)
        .merge(public_read)
        .merge(locks::routes())
        .merge(sessions::routes())
        .merge(users::routes())
        .merge(destinations::routes())
        .merge(legal::routes())
        .merge(live::routes())
        .layer(CorsLayer::permissive())
        .layer(
            ServiceBuilder::new()
                // must run before TraceLayer so the span below can read the id
                .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
                .layer(
                    TraceLayer::new_for_http()
                        .make_span_with(|req: &Request| {
                            let request_id = request_id_header(req.extensions().get::<RequestId>());
                            tracing::info_span!(
                                "http_request",
                                %request_id,
                                method = %req.method(),
                                uri = %req.uri(),
                                user_id = tracing::field::Empty,
                            )
                        })
                        .on_response(DefaultOnResponse::new().level(Level::INFO)),
                )
                // echo the id back so a beta tester can report it
                .layer(PropagateRequestIdLayer::x_request_id()),
        )
        .with_state(state)
}

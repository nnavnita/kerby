// sqlx::query_as tuples are intentionally verbose — they mirror the SELECT list.
// Extracting a `type` alias per query hurts readability more than it helps.
#![allow(clippy::type_complexity)]

pub mod auth;
pub mod bays;
pub mod destinations;
pub mod error;
pub mod legal;
pub mod live;
pub mod locks;
pub mod lots;
pub mod sessions;
pub mod share;
pub mod state;
pub mod users;

use std::sync::Arc;
use std::time::Duration;

use axum::routing::get;
use axum::Router;
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::GovernorLayer;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub use state::AppState;

pub const DEFAULT_JWT_TTL_SECS: i64 = 30 * 24 * 60 * 60;

pub fn build_router(state: AppState, with_rate_limit: bool) -> Router {
    let mut public_read = Router::new()
        .merge(bays::routes())
        .merge(lots::routes())
        .merge(share::routes());
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
        .route("/health", get(|| async { "ok" }))
        .merge(auth_gated)
        .merge(public_read)
        .merge(locks::routes())
        .merge(sessions::routes())
        .merge(users::routes())
        .merge(destinations::routes())
        .merge(legal::routes())
        .merge(live::routes())
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

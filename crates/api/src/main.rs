use std::net::SocketAddr;
use std::sync::Arc;

use tracing_subscriber::EnvFilter;

use kerby_api::state::AppState;
use kerby_api::{build_router, live, DEFAULT_JWT_TTL_SECS};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let db_url = std::env::var("DATABASE_URL")?;
    let redis_url = std::env::var("REDIS_URL")?;
    let jwt_secret = std::env::var("JWT_SECRET")?;
    if jwt_secret == "change-me-before-deploy" {
        tracing::warn!("JWT_SECRET is the default placeholder; do not deploy this!");
    }
    let jwt_ttl_secs: i64 = std::env::var("JWT_TTL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_JWT_TTL_SECS);

    let db = sqlx::PgPool::connect(&db_url).await?;
    sqlx::migrate!("../../migrations").run(&db).await?;
    let redis_client = redis::Client::open(redis_url)?;

    let (events_tx, _) = tokio::sync::broadcast::channel::<live::SensorEvent>(1024);
    live::spawn_redis_bridge(redis_client.clone(), events_tx.clone()).await;

    let state = AppState {
        db,
        redis: redis_client,
        jwt_secret: Arc::new(jwt_secret),
        jwt_ttl_secs,
        events: events_tx,
    };

    let app = build_router(state, true);

    let addr: SocketAddr = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "kerby-api listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

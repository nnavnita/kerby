#![allow(clippy::type_complexity)]

use std::time::Duration;

use tracing_subscriber::EnvFilter;

mod com;
mod etl;
mod etl_lots;
mod poller;
mod pusher;
mod sweeper;

const ETL_INTERVAL_SECS: u64 = 24 * 60 * 60;
const DEFAULT_POLL_INTERVAL_SECS: u64 = 30;
const SWEEP_INTERVAL_SECS: u64 = 60;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let db_url = std::env::var("DATABASE_URL")?;
    let redis_url = std::env::var("REDIS_URL")?;
    let com_base = std::env::var("COM_API_BASE")?;
    let com_key = std::env::var("COM_API_KEY").ok().filter(|s| !s.is_empty());
    let poll_secs: u64 = std::env::var("SENSOR_POLL_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_POLL_INTERVAL_SECS);

    let pool = sqlx::PgPool::connect(&db_url).await?;
    let redis_client = redis::Client::open(redis_url)?;
    let com = com::ComClient::new(com_base, com_key)?;
    let pusher = pusher::Pusher::new()?;

    let etl_handle = {
        let pool = pool.clone();
        let com = com.clone();
        tokio::spawn(async move {
            loop {
                match etl::run_bay_etl(&pool, &com).await {
                    Ok(r) => tracing::info!(
                        fetched = r.fetched,
                        ingestible = r.ingestible,
                        upserted = r.upserted,
                        deleted = r.deleted,
                        elapsed_ms = (r.finished_at - r.started_at).num_milliseconds(),
                        "bay etl complete"
                    ),
                    Err(e) => tracing::error!(error = ?e, "bay etl failed"),
                }
                match etl_lots::run_lot_etl(&pool, &com).await {
                    Ok(r) => tracing::info!(
                        fetched = r.fetched,
                        ingestible = r.ingestible,
                        upserted = r.upserted,
                        deleted = r.deleted,
                        "lot etl complete"
                    ),
                    Err(e) => tracing::error!(error = ?e, "lot etl failed"),
                }
                tokio::time::sleep(Duration::from_secs(ETL_INTERVAL_SECS)).await;
            }
        })
    };

    let poll_handle = {
        let redis_client = redis_client.clone();
        let com = com.clone();
        let pool = pool.clone();
        let pusher = pusher.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(poll_secs));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                let started = std::time::Instant::now();
                match poller::run_sensor_poll(&redis_client, &com, &pool, &pusher).await {
                    Ok(r) => tracing::info!(
                        total = r.total,
                        present = r.present,
                        unoccupied = r.unoccupied,
                        unknown = r.unknown,
                        changes = r.changes,
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        "sensor poll complete"
                    ),
                    Err(e) => tracing::error!(error = ?e, "sensor poll failed"),
                }
            }
        })
    };

    let sweep_handle = {
        let pool = pool.clone();
        let pusher = pusher.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(SWEEP_INTERVAL_SECS));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                match sweeper::sweep_locks(&pool).await {
                    Ok(0) => {}
                    Ok(n) => tracing::info!(expired_locks = n, "swept expired locks"),
                    Err(e) => tracing::error!(error = ?e, "lock sweep failed"),
                }
                match pusher.notify_pre_expiry(&pool).await {
                    Ok(0) => {}
                    Ok(n) => tracing::info!(pre_expiry_pushes = n, "sent pre-expiry pushes"),
                    Err(e) => tracing::error!(error = ?e, "pre-expiry push failed"),
                }
            }
        })
    };

    tracing::info!(
        poll_interval_secs = poll_secs,
        etl_interval_secs = ETL_INTERVAL_SECS,
        sweep_interval_secs = SWEEP_INTERVAL_SECS,
        "kerby-worker running"
    );

    tokio::select! {
        _ = tokio::signal::ctrl_c() => tracing::info!("received Ctrl-C, shutting down"),
        _ = etl_handle => tracing::error!("etl task exited unexpectedly"),
        _ = poll_handle => tracing::error!("poll task exited unexpectedly"),
        _ = sweep_handle => tracing::error!("sweep task exited unexpectedly"),
    }
    Ok(())
}

use std::sync::Arc;
use tokio::sync::broadcast;

use crate::live::SensorEvent;

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::PgPool,
    pub redis: redis::Client,
    pub jwt_secret: Arc<String>,
    pub jwt_ttl_secs: i64,
    pub events: broadcast::Sender<SensorEvent>,
    pub http: reqwest::Client,
    pub google_maps_key: Option<Arc<String>>,
}

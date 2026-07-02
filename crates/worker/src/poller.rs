use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};

use crate::com::ComClient;
use crate::pusher::Pusher;
use sqlx::PgPool;

const SENSOR_DATASET: &str = "on-street-parking-bay-sensors";
// Sensor entries live 6h in Redis; API layer decides freshness via max_stale_secs.
const REDIS_TTL_SECS: u64 = 6 * 60 * 60;

#[derive(Debug, Deserialize)]
struct SensorRecord {
    kerbsideid: i64,
    status_description: String,
    status_timestamp: DateTime<Utc>,
    #[serde(default)]
    zone_number: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct SensorPayload {
    status: String,
    source_updated_at: DateTime<Utc>,
    fetched_at: DateTime<Utc>,
    zone_number: Option<i32>,
}

#[derive(Debug)]
pub struct PollReport {
    pub total: usize,
    pub present: usize,
    pub unoccupied: usize,
    pub unknown: usize,
    pub changes: usize,
}

fn normalise_status(raw: &str) -> &'static str {
    match raw {
        "Present" => "present",
        "Unoccupied" => "unoccupied",
        _ => "unknown",
    }
}

pub async fn run_sensor_poll(
    redis_client: &redis::Client,
    com: &ComClient,
    db: &PgPool,
    pusher: &Pusher,
) -> Result<PollReport> {
    let records: Vec<SensorRecord> = com
        .fetch_export(SENSOR_DATASET)
        .await
        .context("fetch sensors")?;
    let total = records.len();

    let fetched_at = Utc::now();
    let mut conn = redis_client
        .get_multiplexed_async_connection()
        .await
        .context("redis connect")?;

    let status_keys: Vec<String> = records
        .iter()
        .map(|r| format!("bay:{}:status", r.kerbsideid))
        .collect();

    // MGET previous values for diff detection.
    let prev: Vec<Option<String>> = if status_keys.is_empty() {
        Vec::new()
    } else {
        conn.mget(&status_keys).await.context("redis mget")?
    };

    let mut pipe = redis::pipe();
    let mut present = 0usize;
    let mut unoccupied = 0usize;
    let mut unknown = 0usize;
    let mut changes = 0usize;
    let mut newly_present: Vec<String> = Vec::new();

    for (i, r) in records.iter().enumerate() {
        let status = normalise_status(&r.status_description);
        match status {
            "present" => present += 1,
            "unoccupied" => unoccupied += 1,
            _ => unknown += 1,
        }
        let payload = SensorPayload {
            status: status.to_string(),
            source_updated_at: r.status_timestamp,
            fetched_at,
            zone_number: r.zone_number,
        };
        let value = serde_json::to_string(&payload)?;
        let key = &status_keys[i];

        // Only compare status to avoid churn from timestamp differences.
        let (changed, prev_status) = if let Some(Some(existing)) = prev.get(i) {
            match serde_json::from_str::<SensorPayload>(existing) {
                Ok(p) => (p.status != status, Some(p.status)),
                Err(_) => (true, None),
            }
        } else {
            (true, None)
        };

        if changed && status == "present" && prev_status.as_deref() == Some("unoccupied") {
            newly_present.push(r.kerbsideid.to_string());
        }

        pipe.set_ex::<_, _>(key, &value, REDIS_TTL_SECS).ignore();
        if changed {
            changes += 1;
            pipe.publish::<_, _>(format!("bay:{}", r.kerbsideid), &value)
                .ignore();
        }
    }

    if !records.is_empty() {
        let _: () = pipe
            .query_async(&mut conn)
            .await
            .context("redis pipeline")?;
    }

    // Push notifications for bays that flipped unoccupied → present while locked.
    for bay_id in newly_present {
        if let Err(e) = pusher.notify_lock_taken(db, &bay_id).await {
            tracing::warn!(error = ?e, bay_id, "lock-taken push failed");
        }
    }

    Ok(PollReport {
        total,
        present,
        unoccupied,
        unknown,
        changes,
    })
}

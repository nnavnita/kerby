use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::PgPool;

use crate::com::ComClient;

const BAY_DATASET: &str = "on-street-parking-bays";
const BATCH_SIZE: usize = 500;

#[derive(Debug, Deserialize)]
struct BayRecord {
    #[serde(default)]
    kerbsideid: Option<String>,
    #[serde(default)]
    roadsegmentid: Option<i32>,
    #[serde(default)]
    roadsegmentdescription: Option<String>,
    latitude: f64,
    longitude: f64,
}

#[derive(Debug)]
pub struct EtlReport {
    pub fetched: usize,
    pub ingestible: usize,
    pub upserted: usize,
    pub deleted: u64,
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
}

pub async fn run_bay_etl(pool: &PgPool, com: &ComClient) -> Result<EtlReport> {
    let started_at = Utc::now();
    tracing::info!(dataset = BAY_DATASET, "fetching bay records from CoM");
    let raw: Vec<BayRecord> = com.fetch_export(BAY_DATASET).await.context("fetch bays")?;
    let fetched = raw.len();

    // Dedupe by kerbsideid (last write wins) and drop rows with null kerbsideid.
    let mut by_id: std::collections::HashMap<String, BayRecord> =
        std::collections::HashMap::with_capacity(raw.len());
    for r in raw {
        if let Some(id) = r.kerbsideid.clone() {
            by_id.insert(id, r);
        }
    }
    let records: Vec<BayRecord> = by_id.into_values().collect();
    let ingestible = records.len();
    let skipped = fetched - ingestible;
    tracing::info!(
        fetched,
        ingestible,
        skipped,
        "fetched bay records (deduped, null-id rows dropped)"
    );

    let mut tx = pool.begin().await?;

    let mut upserted = 0usize;
    for chunk in records.chunks(BATCH_SIZE) {
        let ids: Vec<&str> = chunk
            .iter()
            .map(|r| r.kerbsideid.as_deref().expect("filtered above"))
            .collect();
        let lngs: Vec<f64> = chunk.iter().map(|r| r.longitude).collect();
        let lats: Vec<f64> = chunk.iter().map(|r| r.latitude).collect();
        let rsids: Vec<Option<i32>> = chunk.iter().map(|r| r.roadsegmentid).collect();
        let streets: Vec<Option<String>> = chunk
            .iter()
            .map(|r| r.roadsegmentdescription.clone())
            .collect();

        let n = sqlx::query(
            r#"
            INSERT INTO bays (id, centroid, road_segment_id, street_name, source_last_seen_at, updated_at)
            SELECT id, ST_MakePoint(lng, lat)::geography, rsid, street, now(), now()
            FROM UNNEST(
                $1::text[],
                $2::float8[],
                $3::float8[],
                $4::int4[],
                $5::text[]
            ) AS t(id, lng, lat, rsid, street)
            ON CONFLICT (id) DO UPDATE SET
                centroid            = EXCLUDED.centroid,
                road_segment_id     = EXCLUDED.road_segment_id,
                street_name         = EXCLUDED.street_name,
                source_last_seen_at = now(),
                updated_at          = now()
            "#,
        )
        .bind(&ids)
        .bind(&lngs)
        .bind(&lats)
        .bind(&rsids)
        .bind(&streets)
        .execute(&mut *tx)
        .await
        .context("upsert bays batch")?
        .rows_affected();
        upserted += n as usize;
    }

    // Sweep: delete bays not seen in this run.
    let deleted = sqlx::query(
        r#"
        DELETE FROM bays
        WHERE source_last_seen_at < $1
        "#,
    )
    .bind(started_at)
    .execute(&mut *tx)
    .await
    .context("sweep stale bays")?
    .rows_affected();

    tx.commit().await.context("commit bay etl")?;

    Ok(EtlReport {
        fetched,
        ingestible,
        upserted,
        deleted,
        started_at,
        finished_at: Utc::now(),
    })
}

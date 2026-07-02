use anyhow::{Context, Result};
use chrono::Utc;
use serde::Deserialize;
use sqlx::PgPool;

use crate::com::ComClient;

const DATASET: &str = "off-street-car-parks-with-capacity-and-type";
const BATCH_SIZE: usize = 500;

#[derive(Debug, Deserialize)]
struct LotRecord {
    // CoM off-street-car-parks-with-capacity-and-type. Row = one property with
    // off-street parking (census-derived). We filter Residential out server-side.
    #[serde(default)]
    property_id: Option<String>,
    #[serde(default)]
    building_address: Option<String>,
    #[serde(default)]
    clue_small_area: Option<String>,
    #[serde(default)]
    parking_type: Option<String>,
    #[serde(default)]
    parking_spaces: Option<i32>,
    #[serde(default)]
    latitude: Option<f64>,
    #[serde(default)]
    longitude: Option<f64>,
    #[serde(default)]
    location: Option<GeoPoint>,
}

#[derive(Debug, Deserialize)]
struct GeoPoint {
    lat: f64,
    lon: f64,
}

#[derive(Debug)]
pub struct LotEtlReport {
    pub fetched: usize,
    pub ingestible: usize,
    pub upserted: usize,
    pub deleted: u64,
}

pub async fn run_lot_etl(pool: &PgPool, com: &ComClient) -> Result<LotEtlReport> {
    let started_at = Utc::now();
    tracing::info!(dataset = DATASET, "fetching off-street lots from CoM");
    let raw: Vec<LotRecord> = com
        .fetch_export(DATASET)
        .await
        .context("fetch off-street lots")?;
    let fetched = raw.len();

    // Filter out residential-only rows (bulk of the dataset) and dedupe by property_id.
    let mut by_id: std::collections::HashMap<String, (LotRecord, f64, f64)> =
        std::collections::HashMap::with_capacity(raw.len());
    for r in raw {
        let Some(id) = r.property_id.clone() else {
            continue;
        };
        let is_residential = r
            .parking_type
            .as_deref()
            .map(|t| t.eq_ignore_ascii_case("Residential"))
            .unwrap_or(false);
        if is_residential {
            continue;
        }
        let (lat, lng) = match (&r.latitude, &r.longitude, &r.location) {
            (Some(la), Some(ln), _) => (*la, *ln),
            (_, _, Some(g)) => (g.lat, g.lon),
            _ => continue,
        };
        by_id.insert(id, (r, lat, lng));
    }
    let records: Vec<(String, LotRecord, f64, f64)> = by_id
        .into_iter()
        .map(|(id, (r, lat, lng))| (id, r, lat, lng))
        .collect();
    let ingestible = records.len();

    let mut tx = pool.begin().await?;
    let mut upserted = 0usize;
    for chunk in records.chunks(BATCH_SIZE) {
        let ids: Vec<&str> = chunk.iter().map(|(id, _, _, _)| id.as_str()).collect();
        let names: Vec<Option<String>> = chunk
            .iter()
            .map(|(_, r, _, _)| r.building_address.clone())
            .collect();
        let operators: Vec<Option<String>> = chunk
            .iter()
            .map(|(_, r, _, _)| r.clue_small_area.clone())
            .collect();
        let types: Vec<Option<String>> = chunk
            .iter()
            .map(|(_, r, _, _)| r.parking_type.clone())
            .collect();
        let caps: Vec<Option<i32>> = chunk.iter().map(|(_, r, _, _)| r.parking_spaces).collect();
        let lngs: Vec<f64> = chunk.iter().map(|(_, _, _, ln)| *ln).collect();
        let lats: Vec<f64> = chunk.iter().map(|(_, _, la, _)| *la).collect();

        let n = sqlx::query(
            r#"
            INSERT INTO off_street_lots
                (id, name, operator, lot_type, capacity, location, source_last_seen_at, updated_at)
            SELECT id, name, operator, lot_type, capacity,
                   ST_MakePoint(lng, lat)::geography, now(), now()
            FROM UNNEST(
                $1::text[], $2::text[], $3::text[], $4::text[], $5::int4[],
                $6::float8[], $7::float8[]
            ) AS t(id, name, operator, lot_type, capacity, lng, lat)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                operator = EXCLUDED.operator,
                lot_type = EXCLUDED.lot_type,
                capacity = EXCLUDED.capacity,
                location = EXCLUDED.location,
                source_last_seen_at = now(),
                updated_at = now()
            "#,
        )
        .bind(&ids)
        .bind(&names)
        .bind(&operators)
        .bind(&types)
        .bind(&caps)
        .bind(&lngs)
        .bind(&lats)
        .execute(&mut *tx)
        .await
        .context("upsert lots batch")?
        .rows_affected();
        upserted += n as usize;
    }

    // Sweep stale.
    let deleted = sqlx::query("DELETE FROM off_street_lots WHERE source_last_seen_at < $1")
        .bind(started_at)
        .execute(&mut *tx)
        .await?
        .rows_affected();

    tx.commit().await?;

    Ok(LotEtlReport {
        fetched,
        ingestible,
        upserted,
        deleted,
    })
}

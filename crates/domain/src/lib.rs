use chrono::{DateTime, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BayShape {
    Parallel,
    Angle45,
    Angle60,
    Perpendicular,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestrictionType {
    Unrestricted,
    Timed,
    Metered,
    Disabled,
    LoadingZone,
    NoParking,
    NoStopping,
    Permit,
    Clearway,
    Taxi,
    Bus,
    Bike,
    Motorcycle,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SensorStatus {
    Present,
    Unoccupied,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LockReleaseReason {
    Parked,
    Expired,
    Cancelled,
    Ghost,
}

pub mod dow {
    pub const MON: i16 = 1 << 0;
    pub const TUE: i16 = 1 << 1;
    pub const WED: i16 = 1 << 2;
    pub const THU: i16 = 1 << 3;
    pub const FRI: i16 = 1 << 4;
    pub const SAT: i16 = 1 << 5;
    pub const SUN: i16 = 1 << 6;
    pub const WEEKDAYS: i16 = MON | TUE | WED | THU | FRI;
    pub const ALL: i16 = WEEKDAYS | SAT | SUN;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatLng {
    pub lat: f64,
    pub lng: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bay {
    pub id: String,
    pub centroid: LatLng,
    pub shape: BayShape,
    pub zone_id: Option<String>,
    pub street_name: Option<String>,
    pub road_segment_id: Option<i32>,
    pub restrictions: Vec<Restriction>,
    pub sensor: Option<SensorReading>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Restriction {
    pub r#type: RestrictionType,
    pub days_of_week: i16,
    pub start_time: Option<NaiveTime>,
    pub end_time: Option<NaiveTime>,
    pub duration_minutes: Option<i32>,
    pub cost_per_hour_cents: Option<i32>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SensorReading {
    pub status: SensorStatus,
    pub source_updated_at: DateTime<Utc>,
    pub fetched_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lock {
    pub id: Uuid,
    pub user_id: Uuid,
    pub bay_id: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub released_at: Option<DateTime<Utc>>,
    pub release_reason: Option<LockReleaseReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParkedSession {
    pub id: Uuid,
    pub user_id: Uuid,
    pub bay_id: Option<String>,
    pub parked_at_geo: LatLng,
    pub photo_url: Option<String>,
    pub note: Option<String>,
    pub parked_at: DateTime<Utc>,
    pub returned_at: Option<DateTime<Utc>>,
}

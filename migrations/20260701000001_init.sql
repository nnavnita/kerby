-- Kerby initial schema (T1.1.1)
-- PostGIS + citext + uuid extensions, core tables, spatial + composite indexes.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------- Enums ----------

CREATE TYPE bay_shape AS ENUM (
    'parallel',
    'angle_45',
    'angle_60',
    'perpendicular',
    'unknown'
);

CREATE TYPE restriction_type AS ENUM (
    'unrestricted',
    'timed',          -- 1P, 2P, 4P, etc (duration_minutes carries the value)
    'metered',
    'disabled',
    'loading_zone',
    'no_parking',
    'no_stopping',
    'permit',
    'clearway',
    'taxi',
    'bus',
    'bike',
    'motorcycle',
    'other'
);

CREATE TYPE sensor_status AS ENUM ('present', 'unoccupied', 'unknown');

CREATE TYPE lock_release_reason AS ENUM ('parked', 'expired', 'cancelled', 'ghost');

-- ---------- Bays (from CoM on-street-parking-bays) ----------

CREATE TABLE bays (
    id                  TEXT PRIMARY KEY,                 -- CoM KerbsideID
    geometry            geometry(Polygon, 4326) NOT NULL, -- bay footprint
    centroid            geography(Point, 4326) NOT NULL,  -- fast radius search in meters
    shape               bay_shape NOT NULL DEFAULT 'unknown',
    zone_id             TEXT,
    street_name         TEXT,
    source_last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bays_centroid_gix ON bays USING GIST (centroid);
CREATE INDEX bays_geometry_gix ON bays USING GIST (geometry);

-- ---------- Restrictions (many per bay, from CoM restrictions dataset) ----------

CREATE TABLE restrictions (
    id                  BIGSERIAL PRIMARY KEY,
    bay_id              TEXT NOT NULL REFERENCES bays(id) ON DELETE CASCADE,
    type                restriction_type NOT NULL,
    days_of_week        SMALLINT NOT NULL,       -- bitmask Mon=1 Tue=2 Wed=4 Thu=8 Fri=16 Sat=32 Sun=64
    start_time          TIME,
    end_time            TIME,
    duration_minutes    INTEGER,                 -- 60 for 1P, 120 for 2P, etc
    cost_per_hour_cents INTEGER,
    notes               TEXT,
    source_hash         TEXT NOT NULL            -- hash of source row for idempotent ETL
);
CREATE INDEX restrictions_bay_id_days ON restrictions (bay_id, days_of_week);
CREATE UNIQUE INDEX restrictions_bay_hash ON restrictions (bay_id, source_hash);

-- ---------- Sensor readings ----------
-- Latest-per-bay lives in Redis (hot path). This table is an append-only archive
-- used for analytics and cold-start recovery when Redis is empty.

CREATE TABLE sensor_readings (
    bay_id              TEXT NOT NULL REFERENCES bays(id) ON DELETE CASCADE,
    status              sensor_status NOT NULL,
    source_updated_at   TIMESTAMPTZ NOT NULL,
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (bay_id, source_updated_at)
);
CREATE INDEX sensor_readings_fetched_at ON sensor_readings (fetched_at DESC);

-- ---------- Users ----------

CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email               CITEXT UNIQUE NOT NULL,
    password_hash       TEXT NOT NULL,
    push_token          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Locks (bay reservations by users, Phase 2) ----------

CREATE TABLE locks (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bay_id              TEXT NOT NULL REFERENCES bays(id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    released_at         TIMESTAMPTZ,
    release_reason      lock_release_reason
);
-- At most one active lock per user
CREATE UNIQUE INDEX locks_active_per_user
    ON locks (user_id) WHERE released_at IS NULL;
-- At most one active lock per bay
CREATE UNIQUE INDEX locks_active_per_bay
    ON locks (bay_id) WHERE released_at IS NULL;
-- Expiry sweep index
CREATE INDEX locks_active_expiry ON locks (expires_at) WHERE released_at IS NULL;

-- ---------- Parked sessions (save spot, walk back) ----------

CREATE TABLE parked_sessions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bay_id              TEXT REFERENCES bays(id) ON DELETE SET NULL,
    parked_at_geo       geography(Point, 4326) NOT NULL,
    photo_url           TEXT,
    note                TEXT,
    parked_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    returned_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX parked_sessions_active_per_user
    ON parked_sessions (user_id) WHERE returned_at IS NULL;
CREATE INDEX parked_sessions_user_history
    ON parked_sessions (user_id, parked_at DESC);

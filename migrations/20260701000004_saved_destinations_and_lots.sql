-- T3.1 saved destinations + T3.2 off-street lots.

CREATE TABLE saved_destinations (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    location            geography(Point, 4326) NOT NULL,
    walk_radius_m       INTEGER NOT NULL DEFAULT 300,
    available_only      BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX saved_destinations_user ON saved_destinations (user_id, created_at DESC);

CREATE TABLE off_street_lots (
    id                  TEXT PRIMARY KEY,
    name                TEXT,
    operator            TEXT,
    lot_type            TEXT,
    capacity            INTEGER,
    location            geography(Point, 4326) NOT NULL,
    source_last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX off_street_lots_location_gix ON off_street_lots USING GIST (location);

-- CoM on-street-parking-bays dataset ships centroids only (no polygon, no shape).
-- Drop unused columns/index. Bays render as points on the map for MVP.

DROP INDEX IF EXISTS bays_geometry_gix;
ALTER TABLE bays DROP COLUMN IF EXISTS geometry;
ALTER TABLE bays ADD COLUMN IF NOT EXISTS road_segment_id INTEGER;

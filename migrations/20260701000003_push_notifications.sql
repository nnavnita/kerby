-- Push-notification metadata on locks.

ALTER TABLE locks ADD COLUMN IF NOT EXISTS taken_notified_at TIMESTAMPTZ;
ALTER TABLE locks ADD COLUMN IF NOT EXISTS pre_expiry_notified_at TIMESTAMPTZ;

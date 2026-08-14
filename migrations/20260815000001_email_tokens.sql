CREATE TYPE email_token_purpose AS ENUM ('reset', 'verify');

CREATE TABLE email_tokens (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    purpose      email_token_purpose NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_tokens_user_purpose_idx
    ON email_tokens (user_id, purpose) WHERE consumed_at IS NULL;

ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;

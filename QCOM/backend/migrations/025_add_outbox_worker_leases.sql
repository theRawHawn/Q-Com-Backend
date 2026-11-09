-- Migration 025: Persist outbox claims so multiple instances cannot process the same event concurrently.

ALTER TABLE outbox_events
    ADD COLUMN IF NOT EXISTS lease_token UUID,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_outbox_pending;

CREATE INDEX IF NOT EXISTS idx_outbox_pending_lease
    ON outbox_events(status, next_attempt_at, lease_expires_at)
    WHERE status = 'PENDING';

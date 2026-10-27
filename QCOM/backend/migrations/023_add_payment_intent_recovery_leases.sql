-- Migration 023: Payment Intent Recovery Metadata and Multi-Instance Worker Leases
-- Enables distributed lease claiming for pending payment recovery without multi-worker lock contention.

ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS reconciliation_attempts INT DEFAULT 0;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS recovery_lease_id VARCHAR(80);
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS recovery_lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payment_intents_recovery_lease ON payment_intents(recovery_lease_expires_at, status);

-- Migration 020: Financial Recovery Metadata and Worker Leases
-- Tracks reconciliation attempts, last reconciliation timestamp, and leases for background recovery

ALTER TABLE refunds ADD COLUMN IF NOT EXISTS reconciliation_attempts INT DEFAULT 0;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS recovery_lease_id VARCHAR(80);
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS recovery_lease_expires_at TIMESTAMPTZ;

ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS reconciliation_attempts INT DEFAULT 0;
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS recovery_lease_id VARCHAR(80);
ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS recovery_lease_expires_at TIMESTAMPTZ;

ALTER TABLE rider_payouts ADD COLUMN IF NOT EXISTS reconciliation_attempts INT DEFAULT 0;
ALTER TABLE rider_payouts ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;
ALTER TABLE rider_payouts ADD COLUMN IF NOT EXISTS recovery_lease_id VARCHAR(80);
ALTER TABLE rider_payouts ADD COLUMN IF NOT EXISTS recovery_lease_expires_at TIMESTAMPTZ;

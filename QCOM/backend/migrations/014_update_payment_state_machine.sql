-- Migration 014: Update Payment State Machine & Add Payment Tracking Columns

-- 1. Extend payment_intents status constraint to support full Payment Lifecycle
ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_status_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_status_check
  CHECK (status IN ('CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'));

-- 2. Add provider reference columns to payment_intents for webhook reconciliation
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS provider_payment_id VARCHAR(120);
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS provider_order_id VARCHAR(120);
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS error_code VARCHAR(80);
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS error_description TEXT;

CREATE INDEX IF NOT EXISTS idx_payment_intents_provider_payment_id ON payment_intents(provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_provider_order_id ON payment_intents(provider_order_id);

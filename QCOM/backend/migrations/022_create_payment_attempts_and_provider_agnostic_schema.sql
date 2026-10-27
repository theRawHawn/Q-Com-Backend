-- Migration 022: Payment Provider-Agnostic Schema & Payment Attempts Tracking
-- Decouples payment intents from specific providers and establishes durable attempt records.

-- 1. Extend payment_intents status constraint to support full provider-agnostic lifecycle
ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_status_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_status_check
  CHECK (status IN (
    'CREATED',
    'PENDING',
    'PROCESSING',
    'AUTHORIZED',
    'CAPTURED',
    'FAILED',
    'CANCELLED',
    'REFUND_PENDING',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'RECONCILIATION_REQUIRED'
  ));

-- 2. Add provider-agnostic tracking columns to payment_intents
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS active_provider VARCHAR(50) DEFAULT 'mock';
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120);

-- 3. Create payment_attempts table for durable multi-attempt lifecycle
CREATE TABLE IF NOT EXISTS payment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    payment_intent_id UUID NOT NULL,
    attempt_number INT NOT NULL DEFAULT 1,
    provider_id VARCHAR(50) NOT NULL,
    provider_reference VARCHAR(120),
    status VARCHAR(40) NOT NULL DEFAULT 'INITIATED' CHECK (status IN (
      'INITIATED',
      'PROCESSING',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'RECONCILIATION_REQUIRED'
    )),
    amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    idempotency_key VARCHAR(120),
    error_code VARCHAR(80),
    error_message TEXT,
    provider_metadata JSONB DEFAULT '{}'::jsonb,
    initiated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    UNIQUE (order_id, attempt_number),
    UNIQUE (provider_id, provider_reference)
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_order ON payment_attempts(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_intent ON payment_attempts(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_provider_ref ON payment_attempts(provider_reference);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON payment_attempts(status);

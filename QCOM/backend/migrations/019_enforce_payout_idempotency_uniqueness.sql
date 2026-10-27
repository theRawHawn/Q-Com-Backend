-- Migration 019: Enforce unique idempotency keys on seller and rider payouts
-- Guarantees that concurrent identical requests cannot create duplicate payout records.

CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_payouts_idemp 
ON seller_payouts (idempotency_key) 
WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_rider_payouts_idemp 
ON rider_payouts (idempotency_key) 
WHERE idempotency_key IS NOT NULL;

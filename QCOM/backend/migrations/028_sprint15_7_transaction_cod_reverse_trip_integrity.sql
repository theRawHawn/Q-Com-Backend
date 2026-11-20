-- Migration 028: Sprint 15.7 Critical Financial & Business Transaction Integrity Repair
-- 1. Replaces unconditional UNIQUE(order_id) on delivery_trips with partial unique indexes
--    separating immutable FORWARD history from REVERSE_PICKUP return logistics trips.
-- 2. Adds otp_failed_attempts counter to delivery_trips for durable OTP retry lockout.
-- 3. Adds location_updated_at GPS freshness tracking on riders for stale/missing GPS exclusion.

-- ============================================================================
-- 1. Delivery Trips: Forward vs Reverse Pickup Separation & OTP Attempt Guard
-- ============================================================================
ALTER TABLE delivery_trips DROP CONSTRAINT IF EXISTS delivery_trips_order_id_key;
ALTER TABLE delivery_trips DROP CONSTRAINT IF EXISTS delivery_trips_constraint_1;
ALTER TABLE delivery_trips DROP CONSTRAINT IF EXISTS delivery_trips_constraint_2;

ALTER TABLE delivery_trips
    ADD COLUMN IF NOT EXISTS trip_type VARCHAR(30) NOT NULL DEFAULT 'FORWARD';

ALTER TABLE delivery_trips
    ADD COLUMN IF NOT EXISTS return_id UUID REFERENCES order_returns(id);

ALTER TABLE delivery_trips
    ADD COLUMN IF NOT EXISTS otp_failed_attempts INT NOT NULL DEFAULT 0;

ALTER TABLE delivery_trips
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE delivery_trips DROP CONSTRAINT IF EXISTS delivery_trips_trip_type_check;
ALTER TABLE delivery_trips ADD CONSTRAINT delivery_trips_trip_type_check CHECK (
    trip_type IN ('FORWARD', 'REVERSE_PICKUP')
);

-- Dynamic PostgreSQL 16 fallback: drop any remaining unconditional UNIQUE constraint on delivery_trips(order_id)
DO $$
DECLARE
    con_name TEXT;
BEGIN
    FOR con_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
        WHERE t.relname = 'delivery_trips'
          AND c.contype = 'u'
          AND array_length(c.conkey, 1) = 1
          AND a.attname = 'order_id'
    LOOP
        EXECUTE format('ALTER TABLE delivery_trips DROP CONSTRAINT IF EXISTS %I', con_name);
    END LOOP;
END $$;

-- Partial unique constraints matching actual business rules:
-- At most one FORWARD delivery trip per order (historical forward record remains intact)
CREATE UNIQUE INDEX IF NOT EXISTS uq_delivery_trips_forward_order
    ON delivery_trips(order_id)
    WHERE trip_type = 'FORWARD';

-- At most one REVERSE_PICKUP trip per return request
CREATE UNIQUE INDEX IF NOT EXISTS uq_delivery_trips_reverse_return
    ON delivery_trips(return_id)
    WHERE trip_type = 'REVERSE_PICKUP' AND return_id IS NOT NULL;

-- At most one ACTIVE reverse pickup trip per order at a time (sequential returns permitted after completion/cancellation)
CREATE UNIQUE INDEX IF NOT EXISTS uq_delivery_trips_active_reverse_order
    ON delivery_trips(order_id)
    WHERE trip_type = 'REVERSE_PICKUP' AND status NOT IN ('DELIVERED', 'RETURNED_TO_HUB', 'CANCELLED');

CREATE INDEX IF NOT EXISTS idx_delivery_trips_order_type
    ON delivery_trips(order_id, trip_type);

CREATE INDEX IF NOT EXISTS idx_delivery_trips_rider_active
    ON delivery_trips(rider_id, status)
    WHERE rider_id IS NOT NULL AND status IN ('ACCEPTED', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'ARRIVED_AT_DROP');

-- ============================================================================
-- 2. Riders: Authoritative GPS Freshness Tracking & Dispatch Eligibility Index
-- ============================================================================
ALTER TABLE riders
    ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE riders
SET location_updated_at = COALESCE(updated_at, NOW())
WHERE latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND location_updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_riders_dispatch_candidates
    ON riders(status, is_payout_held, location_updated_at)
    WHERE status IN ('AVAILABLE', 'IDLE_AT_HUB')
      AND is_payout_held = FALSE
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL;

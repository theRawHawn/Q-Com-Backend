# SPRINT 5 — DISPATCH BASELINE AUDIT

**Date:** 2026-09-29  
**Scope:** Pre-Implementation Baseline Audit of QCOM Dispatch Infrastructure  
**Author:** AI Studio Coding Engine  

---

## 1. EXISTING DATABASE SCHEMA & ENTITIES

### A. Existing Rider Tables (`riders`)
From `004_create_orders_and_trips.sql`:
* `id` (UUID, Primary Key)
* `rider_code` (VARCHAR(30), Unique)
* `name` (VARCHAR(120))
* `phone` (VARCHAR(20), Unique)
* `pan_number` (VARCHAR(10)), `pan_status` (VARCHAR(40))
* `vehicle_type` (VARCHAR(30), CHECK: `bicycle`, `ev_scooter`, `motorcycle`, `cargo_3w`)
* `vehicle_plate` (VARCHAR(30))
* `payload_capacity_kg` (NUMERIC(6,2), Default 15.00)
* `rating` (NUMERIC(3,2), Default 5.00)
* `tier` (VARCHAR(20), Default 'Bronze')
* `status` (VARCHAR(30), Default 'OFFLINE', CHECK: `OFFLINE`, `IDLE_AT_HUB`, `PICKING_UP`, `IN_TRANSIT`, `ARRIVED_AT_DROP`, `SUSPENDED`)
* `latitude` (NUMERIC(10,7)), `longitude` (NUMERIC(10,7))
* `floating_cash_balance`, `floating_cash_limit`, `wallet_balance`, `fy_gross_payout_inr`
* `is_payout_held`, `payout_hold_reason`, `upi_vpa`, `bank_account_number`, `bank_ifsc`, `kyc_status`
* `created_at`, `updated_at`
* **Indexes:** `idx_riders_phone`

### B. Existing Trip Tables (`delivery_trips`)
From `004_create_orders_and_trips.sql`:
* `id` (UUID, Primary Key)
* `order_id` (UUID, Unique, REFERENCES `orders(id)`)
* `rider_id` (UUID, REFERENCES `riders(id)`)
* `status` (VARCHAR(30), Default 'BROADCASTING', CHECK: `BROADCASTING`, `ACCEPTED`, `ARRIVED_AT_PICKUP`, `PICKED_UP`, `ARRIVED_AT_DROP`, `DELIVERED`, `RETURNED_TO_HUB`, `CANCELLED`)
* `broadcasted_at`, `accepted_at`, `picked_up_at`, `delivered_at`
* `otp_verified`, `contactless_photo_url`, `photo_watermark_metadata`
* `cod_due_amount`, `cod_collected_amount`, `cod_reconciled`
* `wait_time_minutes`, `wait_time_compensation`
* `base_fare`, `distance_fare`, `surge_fare`, `tip_amount`, `platform_tip_commission`, `rider_tip_payable`
* `rider_withholding_amount`, `rider_withholding_rule_id`, `rider_withholding_law`, `rider_withholding_provision`, `rider_withholding_table_item`
* `total_rider_payout`, `route_polyline`
* **Indexes:** `idx_delivery_trips_order`, `idx_delivery_trips_rider`

---

## 2. EXISTING DOMAIN SERVICES & INFRASTRUCTURE

### C. Delivery Economics (`DeliveryEconomicsService`)
* **Location:** `QCOM/backend/src/modules/delivery/deliveryEconomicsService.ts`
* **Authority:** Payout configuration in `delivery_economics_configs` table (`rider_base_payout`, `rider_per_km_rate`, `max_delivery_subsidy`).
* **Functions:** `getConfig()`, `calculateRiderPayout(distanceKm, config)`, `calculateUnitEconomics(...)`.

### D. Routing Service (`RoutingService`)
* **Location:** `QCOM/backend/src/modules/routing/routingService.ts`
* **Authority:** Distance calculations, Haversine formula, 100m statutory rounding, entrance pin snapping (`entrance_corrections`), and corridor telemetry (`route_telemetry`).
* **Functions:** `calculateHaversineDistanceMeters()`, `roundTo100Meters()`, `calculateRoute()`, `recordTelemetry()`.

### E. Order Lifecycle (`OrderService`)
* **Location:** `QCOM/backend/src/modules/orders/orderService.ts`
* **States:** `placed`, `picking`, `packed`, `out_for_delivery`, `arriving`, `delivered`, `cancelled`.
* **Idempotency Integration:** Enforced via `idempotency_keys` table with SHA-256 request fingerprinting.

### F. Shared Utilities
* **Transaction Utility:** `transaction(async (client) => ...)` in `QCOM/backend/src/database/connection.js`. Issues ACID `BEGIN`/`COMMIT`/`ROLLBACK` with connection pool release.
* **Idempotency Infrastructure:** `idempotency_keys` table (Migration 006) storing `idempotency_key`, `actor_id`, `endpoint`, `status` (`PROCESSING`, `COMPLETED`, `FAILED`), `request_fingerprint`, `response_body`, `expires_at`.
* **Cache:** `getRedis()` non-authoritative caching layer in `QCOM/backend/src/cache/redis.ts`.

---

## 3. IDENTIFIED GAPS FOR SPRINT 5 DISPATCH

1. **Explicit Dispatch Assignments & Offers:**
   While `delivery_trips` tracks physical trips, there are no dedicated PostgreSQL schema tables for `dispatch_assignments` or `dispatch_offers` to model candidate offers, timer expiration, rejection reasons, and rematching history.
2. **Dispatch State Machine:**
   Need an explicit state machine for assignment lifecycle (`CREATED` → `OFFERED` → `ACCEPTED`/`REJECTED`/`EXPIRED`/`CANCELLED` → `COMPLETED`) and rider states (`OFFLINE`, `AVAILABLE`, `OFFERED`, `ASSIGNED`, `PICKING_UP`, `ON_TRIP`, `UNAVAILABLE`, `SUSPENDED`).
3. **Candidate Generation & Scoring Abstraction:**
   Need a modular candidate generator (`CandidateGenerator`) and replaceable candidate scoring strategy (`DispatchScoringStrategy`) that incorporates routing ETA, distance, rider rating, payload capacity, and delivery economics.
4. **Atomic Concurrency Protection:**
   Must ensure row-level locking (`FOR UPDATE`) on rider and assignment records so concurrent dispatch workers cannot double-assign riders or duplicate orders.

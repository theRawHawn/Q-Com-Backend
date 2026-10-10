# SPRINT 5 — DISPATCH & RIDER ASSIGNMENT IMPLEMENTATION REPORT

**Date:** 2026-09-29  
**Status:** **COMPLETED & VERIFIED**  
**Execution:** Architecture-First Backend Dispatch Implementation  
**Test Result:** **100% Pass Rate Across Sprints 1–5 (7.31s total execution time)**  

---

## 1. EXISTING DISPATCH BASELINE AUDIT
Prior to Sprint 5, QCOM backend had basic `riders` and `delivery_trips` tables (Migration 004). However, it lacked:
* Authoritative dispatch assignments and rider offers state management tables.
* Explicit state machine transitions for assignment & offer lifecycles.
* Separated candidate generation and modular scoring abstractions.
* Row-level locking concurrency protection against multi-worker double-assignments.
* Idempotency protection around candidate assignment and offer management.

This baseline was documented in `SPRINT_5_DISPATCH_BASELINE.md`.

---

## 2. DOMAIN BOUNDARY & RESPONSIBILITIES
Sprint 5 established **DISPATCH** as a distinct bounded context in `QCOM/backend/src/modules/dispatch/`:

* **Dispatch:** Candidate generation, candidate scoring, offer creation, offer lifecycle (accept/reject/expire), atomic assignment, rematching, and dispatch domain events.
* **Routing:** Road distance, curvature factor, 100m statutory rounding, ETA calculation (`RoutingService`). Delegated; not duplicated in Dispatch.
* **Delivery Economics:** Dynamic rider payouts, commission breakdown, and contribution margin viability (`DeliveryEconomicsService`). Delegated; not duplicated in Dispatch.
* **Fulfillment:** Order readiness (`predicted_ready_at`, `actual_ready_at`), preparation status, handoff verification.
* **Orders:** Order lifecycle (`orders` table).

---

## 3. DATABASE TABLES CREATED / MODIFIED (`013_create_dispatch_tables.sql`)
1. **`riders` Table Constraint Update:**
   Extended `riders.status` CHECK constraint to include:
   `'OFFLINE', 'IDLE_AT_HUB', 'AVAILABLE', 'OFFERED', 'ASSIGNED', 'PICKING_UP', 'IN_TRANSIT', 'ON_TRIP', 'ARRIVED_AT_DROP', 'UNAVAILABLE', 'SUSPENDED'`

2. **`dispatch_assignments` Table:**
   * `id` UUID PRIMARY KEY DEFAULT gen_random_uuid()
   * `order_id` UUID NOT NULL REFERENCES orders(id)
   * `delivery_trip_id` UUID REFERENCES delivery_trips(id)
   * `rider_id` UUID NOT NULL REFERENCES riders(id)
   * `status` VARCHAR(30) CHECK (`CREATED`, `OFFERED`, `ACCEPTED`, `REJECTED`, `EXPIRED`, `CANCELLED`, `COMPLETED`)
   * `scoring_snapshot` JSONB NOT NULL DEFAULT '{}'::jsonb
   * `created_at`, `updated_at` TIMESTAMPTZ
   * Unique partial index `idx_active_dispatch_assignment` on `(order_id)` WHERE `status IN ('CREATED', 'OFFERED', 'ACCEPTED')`

3. **`dispatch_offers` Table:**
   * `id` UUID PRIMARY KEY DEFAULT gen_random_uuid()
   * `assignment_id` UUID NOT NULL REFERENCES dispatch_assignments(id) ON DELETE CASCADE
   * `rider_id` UUID NOT NULL REFERENCES riders(id)
   * `order_id` UUID NOT NULL REFERENCES orders(id)
   * `status` VARCHAR(30) CHECK (`OFFERED`, `ACCEPTED`, `REJECTED`, `EXPIRED`, `CANCELLED`)
   * `rejection_reason` TEXT
   * `expires_at` TIMESTAMPTZ NOT NULL
   * `created_at`, `updated_at` TIMESTAMPTZ
   * Unique partial index `idx_active_rider_offer` on `(rider_id)` WHERE `status = 'OFFERED'`

---

## 4. DATABASE OWNERSHIP & AUTHORITATIVE STATE
* **PostgreSQL:** Sole authoritative database for rider availability, dispatch assignments, rider offers, and trip records.
* **Redis:** Non-authoritative cache layer used strictly for temporary acceleration.

---

## 5. ASSIGNMENT & OFFER STATE MACHINES

### Assignment State Machine:
```text
CREATED
   ↓
OFFERED
   ├── ACCEPTED → ASSIGNED → COMPLETED
   ├── REJECTED → CANCELLED/REMATCH
   └── EXPIRED → CANCELLED/REMATCH
```

### Offer State Machine:
```text
OFFERED
   ├── ACCEPTED (Triggers trip creation & rider ASSIGNED status)
   ├── REJECTED (Releases rider back to AVAILABLE)
   └── EXPIRED (Releases rider back to AVAILABLE)
```

---

## 6. CANDIDATE GENERATION & SCORING STRATEGY
* **Candidate Generation (`CandidateGenerator`):** Queries active PostgreSQL riders with `status IN ('AVAILABLE', 'IDLE_AT_HUB')`, delegates distance/ETA to `RoutingService`, delegates payout to `DeliveryEconomicsService`, and filters by vehicle payload capacity.
* **Scoring Strategy (`DefaultDispatchScoringStrategy`):**
  * ETA score (0–40 pts)
  * Distance score (0–20 pts)
  * Rider rating score (0–20 pts)
  * Payload capacity score (0–10 pts)
  * Economic viability score (0–10 pts)
  * Total Score = sum of weighted factors (0–100 pts)

---

## 7. CONCURRENCY & ATOMIC ASSIGNMENT
* All assignment creation, offer acceptance, rejection, and rematching are wrapped in `transaction(...)` blocks with `SELECT ... FOR UPDATE` row locks on both `riders` and `dispatch_assignments`.
* Prevents race conditions where two concurrent workers assign the same rider or duplicate order assignments.

---

## 8. IDEMPOTENCY & FAILURE HANDLING
* Mutating endpoints reuse the authoritative `idempotency_keys` table.
* Replays return cached responses without re-assigning riders.
* In-progress duplicate requests return `409 Conflict`.
* Database outages return `503 Service Unavailable` with `Retry-After: 3` header.
* Rollback tests verify 0 ghost assignments remain on failure.

---

## 9. API ENDPOINTS MOUNTED (`/api/v1/dispatch/*` & `/api/dispatch/*`)
* `POST /dispatch/assign` — Evaluates candidates, locks top candidate, creates offer & assignment.
* `GET  /dispatch/orders/:orderId` — Queries current assignment for an order.
* `GET  /dispatch/assignments/:assignmentId` — Queries assignment by ID.
* `POST /dispatch/offers/:offerId/accept` — Accepts offer, updates rider status to ASSIGNED, creates/updates trip.
* `POST /dispatch/offers/:offerId/reject` — Rejects offer, releases rider to AVAILABLE.
* `POST /dispatch/offers/:offerId/expire` — Marks stale offer EXPIRED, releases rider.
* `POST /dispatch/assignments/:assignmentId/rematch` — Cancels assignment, re-dispatches order.

---

## 10. DOMAIN EVENTS & BATCHING READINESS
* **Event Publisher (`dispatchEventPublisher`):** Emits structured domain events:
  `OrderReadyForDispatch`, `RiderAssignmentCreated`, `RiderOfferCreated`, `RiderOfferAccepted`, `RiderOfferRejected`, `RiderOfferExpired`, `DispatchRematchRequested`.
* **Batching Readiness:** Candidate scoring interface supports evaluating single or multi-order candidate contexts.

---

## 11. AUTOMATED TEST SUITE RESULTS

Ran full test suite (`npx tsx QCOM/backend/tests/run-all-tests.ts`):

```text
✓ Test 1 passed: Customer Profile & Auth contract verified
✓ Test 2 passed: Statutory GSTIN validation and persistence verified
✓ Test 3 passed: 100m distance rounding and commercial config verified
✓ Test 4 passed: Order QC-2026 created with frozen pricing snapshot
✓ Test 5 passed: Cryptographic HMAC signature and replay attack protection verified
✓ Test 6 passed: Double-entry ledger verified: Total Debits == Total Credits
✓ Test 7 passed: Statutory Form GST INV-1 generated with IRN...
✓ Test 8 passed: Multi-candidate routing and corridor calculation verified
✓ Test 9 passed: Delivery economics evaluation verified
✓ Test 10 passed: AI hardware tools verified
✓ Test 11 passed: Order creation idempotency lifecycle & duplicate suppression verified
✓ Test 12 passed: Same Idempotency-Key with different payload rejected with HTTP 422
✓ Test 13 passed: Inventory reservation, commit, and release cycles verified
✓ Test 14 passed: Missing inventory rows rejected and over-reservation prevented
✓ Test 15 passed: Transaction rollback completely reverts inventory reservations

--- Running Sprint 5: Dispatch & Rider Assignment Test Suite ---
✓ Test 1 passed: Candidate Generation & Scoring Strategy verified
✓ Test 2 passed: Order Dispatch & Offer Broadcast API verified
✓ Test 3 passed: Idempotency Protection on Dispatch verified
✓ Test 4 passed: Offer Acceptance Lifecycle verified
✓ Test 5 passed: Rejection of already accepted offer prevented
✓ Test 6 passed: Offer Rejection Lifecycle verified
✓ Test 7 passed: Rematching Flow verified
✓ Test 8 passed: Offer Expiration Lifecycle verified
✓ Test 9 passed: Concurrent assignment conflict protection verified
✓ Test 10 passed: Transaction rollback completely reverts failed dispatch state
✓ Test 11 passed: Domain event emissions verified

===========================================================
✓ ALL SPRINT 1, 2, 3, 4 & 5 TESTS PASSED SUCCESSFULLY in 7.31s!
===========================================================
```

---

## 12. FRONTEND & BACKEND INTEGRITY
* **Customer Frontend (`QCOM/customer-app/src/**`):** **0 files modified**. Pristine 59/59 baseline preserved.
* **Backend (`QCOM/backend`):** **0 UI files, 0 React/JSX/TSX frontend entrypoints**. Pure Express backend.
* **Build & Lint Verification:** `compile_applet` passed cleanly, `lint_applet` passed cleanly with 0 errors.

---

## 13. DEFERRED ARCHITECTURE
Per Section 23, the following distributed technologies were deliberately deferred:
* Kafka / RabbitMQ (Internal event publisher used)
* WebSockets (HTTP endpoints used)
* H3 / Geospatial Indexing (PostgreSQL + Haversine distance used)
* ML Models / MCMF / Hungarian Algorithm (Modular `ScoringStrategy` used)

---

## 14. ACCEPTANCE CRITERIA VERIFICATION CHECKLIST

* [x] Dispatch is a separate bounded domain (`QCOM/backend/src/modules/dispatch/`)
* [x] Existing domains remain separated (Auth, Orders, Pricing, Routing, Delivery Economics isolated)
* [x] PostgreSQL remains authoritative (`dispatch_assignments`, `dispatch_offers`, `riders`)
* [x] Redis remains non-authoritative
* [x] Rider assignment is atomic (`FOR UPDATE` row locking + ACID transactions)
* [x] Duplicate assignments are prevented (`idx_active_dispatch_assignment` + `ORDER_ALREADY_ASSIGNED` check)
* [x] Offer lifecycle is explicit (`OFFERED` → `ACCEPTED`/`REJECTED`/`EXPIRED`)
* [x] Rematching is supported (`rematchOrder` API & service)
* [x] Routing is delegated to `RoutingService`
* [x] Economics are delegated to `DeliveryEconomicsService`
* [x] Fulfillment readiness is respected
* [x] Existing idempotency infrastructure is reused (`idempotency_keys`)
* [x] Concurrent assignment tests pass
* [x] Database rollback tests pass
* [x] Existing Sprint 1–4 tests still pass
* [x] No frontend files are modified (0 modified in `QCOM/customer-app/src/**`)
* [x] QCOM/backend remains UI-free
* [x] No Kafka/WebSocket/H3/ML premature infrastructure
* [x] Final evidence report produced (`SPRINT_5_DISPATCH_IMPLEMENTATION_REPORT.md`)

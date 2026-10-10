import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { setPool, transaction } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { candidateGenerator } from '../src/modules/dispatch/candidateGenerator.js';
import { defaultScoringStrategy } from '../src/modules/dispatch/dispatchScoringStrategy.js';
import { dispatchService } from '../src/modules/dispatch/dispatchService.js';
import { dispatchEventPublisher } from '../src/modules/dispatch/dispatchEvents.js';
import { signAccessToken } from '../src/modules/auth/jwt.js';

export async function runSprint5DispatchTests(): Promise<void> {
  console.log('\n===========================================================');
  console.log('--- Running Sprint 5: Dispatch & Rider Assignment Test Suite ---');
  console.log('===========================================================');

  const { pool } = createTestDatabase();
  setPool(pool);

  // Apply all migrations (001-013)
  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Helper to provision test users, sessions, and sign access tokens
  async function createTestAuth(params: {
    userId?: string;
    phone: string;
    name: string;
    roleCode: string;
    riderId?: string;
  }): Promise<{ token: string; userId: string; sessionId: string }> {
    const candidateUserId = params.userId || crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    // 1. Insert or get user
    const userRes = await pool.query(
      `INSERT INTO users (id, phone, name, is_phone_verified, account_type)
       VALUES ($1, $2, $3, TRUE, 'individual')
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [candidateUserId, params.phone, params.name]
    );
    const userId = userRes.rows[0].id;

    // 2. Assign role
    const roleRes = await pool.query(`SELECT id FROM roles WHERE code = $1`, [params.roleCode]);
    if (roleRes.rows.length > 0) {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, roleRes.rows[0].id]
      );
    }

    // 3. Link rider if provided
    if (params.riderId) {
      await pool.query(`UPDATE riders SET user_id = $1, phone = $2 WHERE id = $3`, [userId, params.phone, params.riderId]);
    }

    // 4. Create active auth session
    await pool.query(
      `INSERT INTO auth_sessions (id, user_id, token_version, status, expires_at)
       VALUES ($1, $2, 1, 'ACTIVE', NOW() + INTERVAL '24 hours')`,
      [sessionId, userId]
    );

    // 5. Sign JWT
    const token = signAccessToken({
      sub: userId,
      session_id: sessionId,
      token_version: 1,
      roles: [params.roleCode],
      phone: params.phone,
    });

    return { token, userId, sessionId };
  }

  try {
    // -------------------------------------------------------------
    // Test 1: Candidate Generation & Scoring Strategy
    // -------------------------------------------------------------
    console.log('[Test 1] Testing Candidate Generation & Scoring Strategy...');
    const merchantRes = await pool.query(`SELECT id, latitude, longitude FROM merchants LIMIT 1`);
    const merchant = merchantRes.rows[0];

    // Ensure at least 2 riders are AVAILABLE
    await pool.query(`
      INSERT INTO riders (id, rider_code, name, phone, vehicle_type, status, latitude, longitude, payload_capacity_kg, rating)
      VALUES 
        (gen_random_uuid(), 'RDR-TEST-001', 'Ramesh Kumar', '+91-9876543210', 'motorcycle', 'AVAILABLE', 12.9716, 77.5946, 20.00, 4.80),
        (gen_random_uuid(), 'RDR-TEST-002', 'Suresh Patel', '+91-9876543211', 'ev_scooter', 'AVAILABLE', 12.9750, 77.5980, 15.00, 4.90)
      ON CONFLICT DO NOTHING
    `);

    const rdr1Res = await pool.query(`SELECT id FROM riders WHERE phone = '+91-9876543210'`);
    const rdr2Res = await pool.query(`SELECT id FROM riders WHERE phone = '+91-9876543211'`);
    const rdr1Id = rdr1Res.rows[0].id;
    const rdr2Id = rdr2Res.rows[0].id;

    // Provision test authentication contexts
    const dispatcherAuth = await createTestAuth({
      phone: '+91-9999900088',
      name: 'Fleet Dispatcher',
      roleCode: 'DISPATCHER',
    });
    const rider1Auth = await createTestAuth({
      phone: '+91-9876543210',
      name: 'Ramesh Kumar',
      roleCode: 'RIDER',
      riderId: rdr1Id,
    });
    const rider2Auth = await createTestAuth({
      phone: '+91-9876543211',
      name: 'Suresh Patel',
      roleCode: 'RIDER',
      riderId: rdr2Id,
    });
    const customerAuth = await createTestAuth({
      phone: '+91-9888800099',
      name: 'Test Customer',
      roleCode: 'CUSTOMER',
    });

    const getRiderToken = (riderId: string) => {
      if (riderId === rdr1Id) return rider1Auth.token;
      if (riderId === rdr2Id) return rider2Auth.token;
      return dispatcherAuth.token;
    };

    const context = {
      orderId: crypto.randomUUID(),
      merchantId: merchant.id,
      storeLocation: { latitude: parseFloat(merchant.latitude || '12.9716'), longitude: parseFloat(merchant.longitude || '77.5946') },
      customerLocation: { latitude: 12.9800, longitude: 77.6000 },
      itemsSubtotal: 500.00,
      customerDeliveryFee: 49.00,
      handlingFee: 15.00,
    };

    const candidates = await candidateGenerator.generateCandidates(context);
    assert.ok(candidates.length >= 2, 'Candidate generator must return at least 2 eligible riders');

    const scored = candidates.map(c => defaultScoringStrategy.scoreCandidate(c, context));
    scored.sort((a, b) => b.score - a.score);
    assert.ok(scored[0].score >= scored[1].score, 'Candidates must be scored and rankable');
    console.log('✓ Test 1 passed: Candidate Generation & Scoring Strategy verified');

    // -------------------------------------------------------------
    // Test 2: Order Dispatch & Offer Broadcast API (/dispatch/assign)
    // -------------------------------------------------------------
    console.log('[Test 2] Testing Order Dispatch & Offer Broadcast API...');
    const userRes = await pool.query(`SELECT id FROM users LIMIT 1`);
    const userId = userRes.rows[0].id;

    // Create a demo order for dispatch
    const orderId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, taxable_amount, total_amount, payment_method, delivery_otp, handover_token, jobsite_address, pricing_snapshot, estimated_delivery_at)
      VALUES ($1, 'QC-2026-TESTDISPATCH', $2, $3, 'placed', 500.00, 49.00, 15.00, 500.00, 564.00, 'Instant UPI', '123456', 'TOKEN123', '{"latitude":12.9800,"longitude":77.6000}', '{}', NOW() + INTERVAL '25 mins')
    `, [orderId, userId, merchant.id]);

    const assignRes = await fetch(`${baseUrl}/api/v1/dispatch/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${dispatcherAuth.token}`,
      },
      body: JSON.stringify({ orderId, offerExpirySeconds: 60 }),
    });
    const assignBody = await assignRes.json();
    assert.strictEqual(assignRes.status, 200);
    assert.strictEqual(assignBody.success, true);
    assert.ok(assignBody.assignment.id, 'Assignment ID must be returned');
    assert.ok(assignBody.offer.id, 'Offer ID must be returned');
    assert.strictEqual(assignBody.offer.status, 'OFFERED');

    const offerId = assignBody.offer.id;
    const assignmentId = assignBody.assignment.id;
    const selectedRiderId = assignBody.selectedRider.riderId;

    // Verify rider status changed to OFFERED in DB
    const riderCheck = await pool.query(`SELECT status FROM riders WHERE id = $1`, [selectedRiderId]);
    assert.strictEqual(riderCheck.rows[0].status, 'OFFERED');
    console.log('✓ Test 2 passed: Order Dispatch & Offer Broadcast API verified');

    // -------------------------------------------------------------
    // Test 3: Idempotency Protection on Dispatch
    // -------------------------------------------------------------
    console.log('[Test 3] Testing Idempotency Protection on Dispatch...');
    const cleanIdempotencyKey = `idemp_dispatch_${crypto.randomUUID()}`;
    const newOrderId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, taxable_amount, total_amount, payment_method, delivery_otp, handover_token, jobsite_address, pricing_snapshot, estimated_delivery_at)
      VALUES ($1, 'QC-2026-IDEMP', $2, $3, 'placed', 400.00, 30.00, 10.00, 400.00, 440.00, 'Instant UPI', '654321', 'TOKEN456', '{"latitude":12.9800,"longitude":77.6000}', '{}', NOW() + INTERVAL '25 mins')
    `, [newOrderId, userId, merchant.id]);

    const req1 = await fetch(`${baseUrl}/api/dispatch/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': cleanIdempotencyKey,
        'Authorization': `Bearer ${dispatcherAuth.token}`,
      },
      body: JSON.stringify({ orderId: newOrderId }),
    });
    const body1 = await req1.json();
    assert.strictEqual(req1.status, 200);

    const req2 = await fetch(`${baseUrl}/api/dispatch/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': cleanIdempotencyKey,
        'Authorization': `Bearer ${dispatcherAuth.token}`,
      },
      body: JSON.stringify({ orderId: newOrderId }),
    });
    const body2 = await req2.json();
    assert.strictEqual(req2.status, 200);
    assert.strictEqual(body2.assignment.id, body1.assignment.id, 'Idempotent request must return identical assignment ID');
    console.log('✓ Test 3 passed: Idempotency Protection on Dispatch verified');

    // -------------------------------------------------------------
    // Test 4: Offer Acceptance Lifecycle (/dispatch/offers/:id/accept)
    // -------------------------------------------------------------
    console.log('[Test 4] Testing Offer Acceptance Lifecycle...');
    const acceptRes = await fetch(`${baseUrl}/api/v1/dispatch/offers/${offerId}/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getRiderToken(selectedRiderId)}`,
      },
      body: JSON.stringify({ riderId: selectedRiderId }),
    });
    const acceptBody = await acceptRes.json();
    assert.strictEqual(acceptRes.status, 200);
    assert.strictEqual(acceptBody.success, true);
    assert.strictEqual(acceptBody.offer.status, 'ACCEPTED');
    assert.strictEqual(acceptBody.assignment.status, 'ACCEPTED');

    // Verify rider status updated to ASSIGNED and trip row created
    const acceptedRiderCheck = await pool.query(`SELECT status FROM riders WHERE id = $1`, [selectedRiderId]);
    assert.strictEqual(acceptedRiderCheck.rows[0].status, 'ASSIGNED');

    const tripCheck = await pool.query(`SELECT status FROM delivery_trips WHERE order_id = $1`, [orderId]);
    assert.strictEqual(tripCheck.rows[0].status, 'ACCEPTED');
    console.log('✓ Test 4 passed: Offer Acceptance Lifecycle verified');

    // -------------------------------------------------------------
    // Test 5: Rejection After Acceptance Prevention
    // -------------------------------------------------------------
    console.log('[Test 5] Testing Rejection After Acceptance Prevention...');
    const rejAfterAccRes = await fetch(`${baseUrl}/api/v1/dispatch/offers/${offerId}/reject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getRiderToken(selectedRiderId)}`,
      },
      body: JSON.stringify({ riderId: selectedRiderId, reason: 'Changed mind' }),
    });
    assert.strictEqual(rejAfterAccRes.status, 400);
    console.log('✓ Test 5 passed: Rejection of already accepted offer prevented');

    // -------------------------------------------------------------
    // Test 6: Offer Rejection Lifecycle (/dispatch/offers/:id/reject)
    // -------------------------------------------------------------
    console.log('[Test 6] Testing Offer Rejection Lifecycle...');
    const rejOrderId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, taxable_amount, total_amount, payment_method, delivery_otp, handover_token, jobsite_address, pricing_snapshot, estimated_delivery_at)
      VALUES ($1, 'QC-2026-REJ', $2, $3, 'placed', 300.00, 20.00, 10.00, 300.00, 330.00, 'Instant UPI', '111222', 'TOKREJ', '{"latitude":12.9800,"longitude":77.6000}', '{}', NOW() + INTERVAL '25 mins')
    `, [rejOrderId, userId, merchant.id]);

    const assignForRej = await dispatchService.assignOrder({ orderId: rejOrderId });
    const rejOfferId = assignForRej.offer.id;
    const rejRiderId = assignForRej.selectedRider.riderId;

    const rejRes = await fetch(`${baseUrl}/api/v1/dispatch/offers/${rejOfferId}/reject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getRiderToken(rejRiderId)}`,
      },
      body: JSON.stringify({ riderId: rejRiderId, reason: 'Distance too far' }),
    });
    const rejBody = await rejRes.json();
    assert.strictEqual(rejRes.status, 200);
    assert.strictEqual(rejBody.offer.status, 'REJECTED');

    // Verify rider status released back to AVAILABLE
    const releasedRiderCheck = await pool.query(`SELECT status FROM riders WHERE id = $1`, [rejRiderId]);
    assert.strictEqual(releasedRiderCheck.rows[0].status, 'AVAILABLE');
    console.log('✓ Test 6 passed: Offer Rejection Lifecycle verified');

    // -------------------------------------------------------------
    // Test 7: Rematching Flow (/dispatch/assignments/:id/rematch)
    // -------------------------------------------------------------
    console.log('[Test 7] Testing Rematching Flow...');
    const rematchRes = await fetch(`${baseUrl}/api/v1/dispatch/assignments/${assignForRej.assignment.id}/rematch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${dispatcherAuth.token}`,
      },
    });
    const rematchBody = await rematchRes.json();
    assert.strictEqual(rematchRes.status, 200);
    assert.ok(rematchBody.newAssignment.id, 'New assignment must be created during rematch');
    assert.notStrictEqual(rematchBody.newAssignment.id, assignForRej.assignment.id, 'New assignment ID must differ from cancelled assignment');
    console.log('✓ Test 7 passed: Rematching Flow verified');

    // -------------------------------------------------------------
    // Test 8: Offer Expiration Lifecycle (/dispatch/offers/:id/expire)
    // -------------------------------------------------------------
    console.log('[Test 8] Testing Offer Expiration Lifecycle...');
    const expOrderId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, taxable_amount, total_amount, payment_method, delivery_otp, handover_token, jobsite_address, pricing_snapshot, estimated_delivery_at)
      VALUES ($1, 'QC-2026-EXP', $2, $3, 'placed', 300.00, 20.00, 10.00, 300.00, 330.00, 'Instant UPI', '333444', 'TOKEXP', '{"latitude":12.9800,"longitude":77.6000}', '{}', NOW() + INTERVAL '25 mins')
    `, [expOrderId, userId, merchant.id]);

    const assignForExp = await dispatchService.assignOrder({ orderId: expOrderId });
    const expOfferId = assignForExp.offer.id;
    const expRiderId = assignForExp.selectedRider.riderId;

    const expRes = await fetch(`${baseUrl}/api/v1/dispatch/offers/${expOfferId}/expire`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${dispatcherAuth.token}`,
      },
    });
    assert.strictEqual(expRes.status, 200);

    const expOfferCheck = await pool.query(`SELECT status FROM dispatch_offers WHERE id = $1`, [expOfferId]);
    assert.strictEqual(expOfferCheck.rows[0].status, 'EXPIRED');

    const expRiderCheck = await pool.query(`SELECT status FROM riders WHERE id = $1`, [expRiderId]);
    assert.strictEqual(expRiderCheck.rows[0].status, 'AVAILABLE');
    console.log('✓ Test 8 passed: Offer Expiration Lifecycle verified');

    // -------------------------------------------------------------
    // Test 9: Concurrent Assignment Conflict Protection
    // -------------------------------------------------------------
    console.log('[Test 9] Testing Concurrent Assignment Conflict Protection...');
    await pool.query(`UPDATE riders SET status = 'AVAILABLE' WHERE status != 'SUSPENDED'`);

    const concOrderId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, taxable_amount, total_amount, payment_method, delivery_otp, handover_token, jobsite_address, pricing_snapshot, estimated_delivery_at)
      VALUES ($1, 'QC-2026-CONC', $2, $3, 'placed', 350.00, 25.00, 10.00, 350.00, 385.00, 'Instant UPI', '555666', 'TOKCONC', '{"latitude":12.9800,"longitude":77.6000}', '{}', NOW() + INTERVAL '25 mins')
    `, [concOrderId, userId, merchant.id]);

    const assign1 = await dispatchService.assignOrder({ orderId: concOrderId });
    assert.ok(assign1.assignment.id);

    // Second concurrent attempt for same order must fail with ORDER_ALREADY_ASSIGNED
    await assert.rejects(
      async () => {
        await dispatchService.assignOrder({ orderId: concOrderId });
      },
      /ORDER_ALREADY_ASSIGNED/
    );
    console.log('✓ Test 9 passed: Concurrent assignment conflict protection verified');

    // -------------------------------------------------------------
    // Test 10: PostgreSQL Transaction Rollback Invariant
    // -------------------------------------------------------------
    console.log('[Test 10] Testing PostgreSQL Transaction Rollback Invariant...');
    await pool.query(`UPDATE dispatch_offers SET status = 'EXPIRED' WHERE status = 'OFFERED'`);
    await pool.query(`UPDATE dispatch_assignments SET status = 'EXPIRED' WHERE status = 'OFFERED'`);
    await pool.query(`UPDATE riders SET status = 'AVAILABLE' WHERE status != 'SUSPENDED'`);

    const rbOrderId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, taxable_amount, total_amount, payment_method, delivery_otp, handover_token, jobsite_address, pricing_snapshot, estimated_delivery_at)
      VALUES ($1, 'QC-2026-ROLLBACK', $2, $3, 'placed', 350.00, 25.00, 10.00, 350.00, 385.00, 'Instant UPI', '999888', 'TOKROLL', '{"latitude":12.9800,"longitude":77.6000}', '{}', NOW() + INTERVAL '25 mins')
    `, [rbOrderId, userId, merchant.id]);

    const preAssignments = await pool.query(`SELECT COUNT(*) as cnt FROM dispatch_assignments`);
    const preCount = Number(preAssignments.rows[0].cnt);

    try {
      await transaction(async (client) => {
        await dispatchService.assignOrder({ orderId: rbOrderId, clientOverride: client });
        throw new Error('SIMULATED_DISPATCH_FAILURE');
      });
    } catch (err: any) {
      assert.strictEqual(err.message, 'SIMULATED_DISPATCH_FAILURE');
    }

    const postAssignments = await pool.query(`SELECT COUNT(*) as cnt FROM dispatch_assignments`);
    assert.strictEqual(Number(postAssignments.rows[0].cnt), preCount, 'Transaction rollback must leave zero ghost assignments');
    console.log('✓ Test 10 passed: Transaction rollback completely reverts failed dispatch state');

    // -------------------------------------------------------------
    // Test 11: Domain Event Emission Verification
    // -------------------------------------------------------------
    console.log('[Test 11] Testing Domain Event Emission Verification...');
    const loggedEvents = dispatchEventPublisher.getLoggedEvents();
    assert.ok(loggedEvents.length > 0, 'Domain events must be logged');
    const eventTypes = new Set(loggedEvents.map(e => e.eventType));
    assert.ok(eventTypes.has('OrderReadyForDispatch'), 'OrderReadyForDispatch event logged');
    assert.ok(eventTypes.has('RiderAssignmentCreated'), 'RiderAssignmentCreated event logged');
    assert.ok(eventTypes.has('RiderOfferCreated'), 'RiderOfferCreated event logged');
    assert.ok(eventTypes.has('RiderOfferAccepted'), 'RiderOfferAccepted event logged');
    console.log('✓ Test 11 passed: Domain event emissions verified');

    // -------------------------------------------------------------
    // Test 12: F-01 Authentication & RBAC Guardrails Verification
    // -------------------------------------------------------------
    console.log('[Test 12] Testing F-01: Authentication & Authorization Guardrails...');
    const f01OrderId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, taxable_amount, total_amount, payment_method, delivery_otp, handover_token, jobsite_address, pricing_snapshot, estimated_delivery_at)
      VALUES ($1, 'QC-2026-F01-AUTH', $2, $3, 'placed', 500.00, 49.00, 15.00, 500.00, 564.00, 'Instant UPI', '123456', 'TOKAUTH', '{"latitude":12.9800,"longitude":77.6000}', '{}', NOW() + INTERVAL '25 mins')
    `, [f01OrderId, userId, merchant.id]);

    // 12.1 Unauthenticated request must return 401 UNAUTHENTICATED
    const unauthRes = await fetch(`${baseUrl}/api/v1/dispatch/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: f01OrderId }),
    });
    assert.strictEqual(unauthRes.status, 401, 'Unauthenticated request must be rejected with 401');
    const unauthBody = await unauthRes.json();
    assert.strictEqual(unauthBody.error, 'UNAUTHENTICATED');

    // 12.2 Customer account cannot dispatch orders (403 FORBIDDEN_ROLE)
    const custAssignRes = await fetch(`${baseUrl}/api/v1/dispatch/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${customerAuth.token}`,
      },
      body: JSON.stringify({ orderId: f01OrderId }),
    });
    assert.strictEqual(custAssignRes.status, 403, 'Customer cannot trigger dispatch assignment');
    const custAssignBody = await custAssignRes.json();
    assert.strictEqual(custAssignBody.error, 'FORBIDDEN_ROLE');

    // 12.3 Customer cannot trigger rematch
    const custRematchRes = await fetch(`${baseUrl}/api/v1/dispatch/assignments/${assignmentId}/rematch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${customerAuth.token}`,
      },
    });
    assert.strictEqual(custRematchRes.status, 403, 'Customer cannot trigger assignment rematch');

    // 12.4 Rider 2 cannot accept Rider 1's offer
    const crossRiderAcceptRes = await fetch(`${baseUrl}/api/v1/dispatch/offers/${offerId}/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${rider2Auth.token}`,
      },
      body: JSON.stringify({ riderId: rdr1Id }),
    });
    assert.strictEqual(crossRiderAcceptRes.status, 403, 'Rider 2 cannot accept Rider 1 offer');
    const crossRiderAcceptBody = await crossRiderAcceptRes.json();
    assert.strictEqual(crossRiderAcceptBody.error, 'RIDER_ACCESS_DENIED');

    // 12.5 Rider 2 cannot reject Rider 1's offer
    const crossRiderRejectRes = await fetch(`${baseUrl}/api/v1/dispatch/offers/${offerId}/reject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${rider2Auth.token}`,
      },
      body: JSON.stringify({ riderId: rdr1Id, reason: 'Malicious reject' }),
    });
    assert.strictEqual(crossRiderRejectRes.status, 403, 'Rider 2 cannot reject Rider 1 offer');
    console.log('✓ Test 12 passed: F-01 Authentication & RBAC guardrails verified');

    // -------------------------------------------------------------
    // Test 13: F-02 Late Offer Acceptance After Assignment Cancellation Prevention
    // -------------------------------------------------------------
    console.log('[Test 13] Testing F-02: Late Offer Acceptance Prevention...');
    await pool.query(`UPDATE riders SET status = 'AVAILABLE' WHERE status != 'SUSPENDED'`);

    const f02OrderId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, taxable_amount, total_amount, payment_method, delivery_otp, handover_token, jobsite_address, pricing_snapshot, estimated_delivery_at)
      VALUES ($1, 'QC-2026-F02-LATE', $2, $3, 'placed', 450.00, 30.00, 10.00, 450.00, 490.00, 'Instant UPI', '987654', 'TOKLATE', '{"latitude":12.9800,"longitude":77.6000}', '{}', NOW() + INTERVAL '25 mins')
    `, [f02OrderId, userId, merchant.id]);

    // Dispatch order to get initial assignment and offer
    const f02AssignRes = await dispatchService.assignOrder({ orderId: f02OrderId });
    const f02OldAssignId = f02AssignRes.assignment.id;
    const f02OldOfferId = f02AssignRes.offer.id;
    const f02OldRiderId = f02AssignRes.selectedRider.riderId;

    // Trigger rematch: cancels old assignment and old offer
    const rematchResult = await dispatchService.rematchOrder(f02OldAssignId);
    assert.strictEqual(rematchResult.oldAssignmentId, f02OldAssignId);

    // Verify in database that old assignment is CANCELLED and old offer is CANCELLED
    const oldAssignCheck = await pool.query(`SELECT status FROM dispatch_assignments WHERE id = $1`, [f02OldAssignId]);
    assert.strictEqual(oldAssignCheck.rows[0].status, 'CANCELLED');

    const oldOfferCheck = await pool.query(`SELECT status FROM dispatch_offers WHERE id = $1`, [f02OldOfferId]);
    assert.strictEqual(oldOfferCheck.rows[0].status, 'CANCELLED');

    // Now Rider A sends a late ACCEPT request for the cancelled offer
    const lateAcceptRes = await fetch(`${baseUrl}/api/v1/dispatch/offers/${f02OldOfferId}/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getRiderToken(f02OldRiderId)}`,
      },
      body: JSON.stringify({ riderId: f02OldRiderId }),
    });

    // Must be rejected with 409 Conflict (or 400) and ASSIGNMENT_CANCELLED / OFFER_INVALID_STATE
    assert.ok([400, 409].includes(lateAcceptRes.status), `Late accept must return 400 or 409, got ${lateAcceptRes.status}`);
    const lateAcceptBody = await lateAcceptRes.json();
    assert.strictEqual(lateAcceptBody.success, false);
    assert.ok(
      lateAcceptBody.error === 'ASSIGNMENT_CANCELLED' || lateAcceptBody.message.includes('CANCELLED'),
      `Error must indicate cancelled assignment/offer: ${JSON.stringify(lateAcceptBody)}`
    );

    // Verify parent assignment remains CANCELLED and was NOT overwritten to ACCEPTED
    const finalAssignCheck = await pool.query(`SELECT status FROM dispatch_assignments WHERE id = $1`, [f02OldAssignId]);
    assert.strictEqual(finalAssignCheck.rows[0].status, 'CANCELLED', 'Cancelled assignment must never transition to ACCEPTED');
    console.log('✓ Test 13 passed: F-02 Late offer acceptance after cancellation strictly prevented');

    // -------------------------------------------------------------
    // Test 14: F-03 Rematch State Hardening
    // -------------------------------------------------------------
    console.log('[Test 14] Testing F-03: Rematch State Hardening...');
    await pool.query(`UPDATE dispatch_offers SET status = 'EXPIRED' WHERE status = 'OFFERED'`);
    await pool.query(`UPDATE dispatch_assignments SET status = 'EXPIRED' WHERE status = 'OFFERED'`);
    await pool.query(`UPDATE riders SET status = 'AVAILABLE' WHERE status != 'SUSPENDED'`);

    const f03OrderId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, taxable_amount, total_amount, payment_method, delivery_otp, handover_token, jobsite_address, pricing_snapshot, estimated_delivery_at)
      VALUES ($1, 'QC-2026-F03-STATE', $2, $3, 'placed', 420.00, 30.00, 10.00, 420.00, 460.00, 'Instant UPI', '222333', 'TOKSTATE', '{"latitude":12.9800,"longitude":77.6000}', '{}', NOW() + INTERVAL '25 mins')
    `, [f03OrderId, userId, merchant.id]);

    const f03Assign = await dispatchService.assignOrder({ orderId: f03OrderId });
    const f03OfferId = f03Assign.offer.id;
    const f03RiderId = f03Assign.selectedRider.riderId;

    // Accept offer so assignment reaches ACCEPTED status
    await dispatchService.acceptOffer(f03OfferId, f03RiderId);

    const acceptedAssign = await pool.query(`SELECT status FROM dispatch_assignments WHERE id = $1`, [f03Assign.assignment.id]);
    assert.strictEqual(acceptedAssign.rows[0].status, 'ACCEPTED');

    // Attempt to rematch an already ACCEPTED assignment via API -> must fail with 409 INVALID_REMATCH_STATE
    const invalidRematchRes = await fetch(`${baseUrl}/api/v1/dispatch/assignments/${f03Assign.assignment.id}/rematch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${dispatcherAuth.token}`,
      },
    });
    assert.strictEqual(invalidRematchRes.status, 409, 'Rematching an ACCEPTED assignment must return 409');
    const invalidRematchBody = await invalidRematchRes.json();
    assert.strictEqual(invalidRematchBody.error, 'INVALID_REMATCH_STATE');

    // Verify assignment status remains ACCEPTED
    const assignCheckPostRematch = await pool.query(`SELECT status FROM dispatch_assignments WHERE id = $1`, [f03Assign.assignment.id]);
    assert.strictEqual(assignCheckPostRematch.rows[0].status, 'ACCEPTED', 'Assignment must remain ACCEPTED');
    console.log('✓ Test 14 passed: F-03 Rematch state validation hardened against completed/accepted states');

    // -------------------------------------------------------------
    // Test 15: F-04 Domain Events Post-Commit Invariant
    // -------------------------------------------------------------
    console.log('[Test 15] Testing F-04: Domain Events Post-Commit Invariant...');
    await pool.query(`UPDATE dispatch_offers SET status = 'EXPIRED' WHERE status = 'OFFERED'`);
    await pool.query(`UPDATE dispatch_assignments SET status = 'EXPIRED' WHERE status = 'OFFERED'`);
    await pool.query(`UPDATE riders SET status = 'AVAILABLE' WHERE status != 'SUSPENDED'`);

    const f04OrderId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, delivery_fee, handling_fee, taxable_amount, total_amount, payment_method, delivery_otp, handover_token, jobsite_address, pricing_snapshot, estimated_delivery_at)
      VALUES ($1, 'QC-2026-F04-EVENTS', $2, $3, 'placed', 380.00, 20.00, 10.00, 380.00, 410.00, 'Instant UPI', '444555', 'TOKEVENTS', '{"latitude":12.9800,"longitude":77.6000}', '{}', NOW() + INTERVAL '25 mins')
    `, [f04OrderId, userId, merchant.id]);

    const initialEventCount = dispatchEventPublisher.getLoggedEvents().length;

    // Simulate aborted transaction
    try {
      await transaction(async (client) => {
        await dispatchService.assignOrder({ orderId: f04OrderId, clientOverride: client });
        throw new Error('SIMULATED_TRANSACTION_ABORT_AFTER_ASSIGN');
      });
    } catch (err: any) {
      assert.strictEqual(err.message, 'SIMULATED_TRANSACTION_ABORT_AFTER_ASSIGN');
    }

    const eventCountAfterAbort = dispatchEventPublisher.getLoggedEvents().length;
    assert.strictEqual(
      eventCountAfterAbort,
      initialEventCount,
      'Aborted transaction must NOT emit domain events to the publisher'
    );

    // Successful transaction must emit events post-commit
    await dispatchService.assignOrder({ orderId: f04OrderId });
    const eventCountAfterSuccess = dispatchEventPublisher.getLoggedEvents().length;
    assert.ok(
      eventCountAfterSuccess > eventCountAfterAbort,
      'Successful committed transaction must emit domain events'
    );
    console.log('✓ Test 15 passed: F-04 Domain events emitted strictly post-commit');

    console.log('===========================================================');
    console.log('✓ ALL SPRINT 5 DISPATCH & RIDER ASSIGNMENT TESTS PASSED!');
    console.log('===========================================================');
  } finally {
    server.close();
  }
}

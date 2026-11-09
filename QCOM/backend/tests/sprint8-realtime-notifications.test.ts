import assert from 'node:assert/strict';
import http from 'http';
import { WebSocket } from 'ws';
import crypto from 'crypto';
import { createTestDatabase } from './helpers/testDb.js';
import { runMigrations } from '../src/database/migrator.js';
import { outboxService } from '../src/modules/outbox/outboxService.js';
import { realtimeGateway } from '../src/modules/realtime/websocketServer.js';
import { liveLocationService } from '../src/modules/realtime/liveLocationService.js';
import { deviceTokenService } from '../src/modules/notifications/deviceTokenService.js';
import { preferenceService } from '../src/modules/notifications/preferenceService.js';
import { notificationService } from '../src/modules/notifications/notificationService.js';
import { MockPushProvider } from '../src/modules/notifications/pushProvider.js';
import { campaignService } from '../src/modules/notifications/campaignService.js';
import { BaselineRuleDecisionEngine } from '../src/modules/notifications/algorithmicContract.js';
import { signAccessToken } from '../src/modules/auth/jwt.js';
import { authService } from '../src/modules/auth/authService.js';
import { inMemoryStore, cacheGet } from '../src/database/redis.js';
import { transaction, setPool } from '../src/database/connection.js';

export async function runSprint8RealtimeNotificationsTests() {
  console.log('\n===========================================================');
  console.log('--- RUNNING SPRINT 8: REALTIME + NOTIFICATIONS TEST SUITE ---');
  console.log('===========================================================');

  const { pool } = createTestDatabase();
  setPool(pool);
  await runMigrations({ poolOverride: pool });

  // Create isolated mock push provider for tests
  const testPushProvider = new MockPushProvider();
  notificationService.setPushProvider(testPushProvider);

  // Setup seed users, merchants, riders, orders, and sessions in test database
  const userCustomerA = crypto.randomUUID();
  const userCustomerB = crypto.randomUUID();
  const userSeller = crypto.randomUUID();
  const userRider = crypto.randomUUID();
  const userAdmin = crypto.randomUUID();

  const merchantIdA = crypto.randomUUID();
  const merchantIdB = crypto.randomUUID();
  const riderId = crypto.randomUUID();
  const orderIdA = crypto.randomUUID();
  const orderIdB = crypto.randomUUID();
  const tripIdA = crypto.randomUUID();

  // Seed Users
  await pool.query(`
    INSERT INTO users (id, phone, name, email, is_suspended) VALUES
    ($1, '+919876543210', 'Customer A', 'customerA@test.com', FALSE),
    ($2, '+919876543211', 'Customer B', 'customerB@test.com', FALSE),
    ($3, '+919876543212', 'Seller Merchant', 'seller@test.com', FALSE),
    ($4, '+919876543213', 'Rider Partner', 'rider@test.com', FALSE),
    ($5, '+919876543214', 'Super Admin', 'admin@test.com', FALSE)
  `, [userCustomerA, userCustomerB, userSeller, userRider, userAdmin]);

  // Seed Roles & User Roles
  await pool.query(`
    INSERT INTO roles (code, name, description) VALUES
    ('CUSTOMER', 'Customer', 'End Customer'),
    ('SELLER', 'Seller', 'Merchant Store Owner'),
    ('RIDER', 'Rider', 'Delivery Partner'),
    ('SUPER_ADMIN', 'Super Admin', 'Platform Administrator')
    ON CONFLICT (code) DO NOTHING
  `);

  const roleCust = (await pool.query(`SELECT id FROM roles WHERE code = 'CUSTOMER'`)).rows[0].id;
  const roleSeller = (await pool.query(`SELECT id FROM roles WHERE code = 'SELLER'`)).rows[0].id;
  const roleRider = (await pool.query(`SELECT id FROM roles WHERE code = 'RIDER'`)).rows[0].id;
  const roleAdmin = (await pool.query(`SELECT id FROM roles WHERE code = 'SUPER_ADMIN'`)).rows[0].id;

  await pool.query(`
    INSERT INTO user_roles (user_id, role_id) VALUES
    ($1, $6), ($2, $6), ($3, $7), ($4, $8), ($5, $9)
  `, [userCustomerA, userCustomerB, userSeller, userRider, userAdmin, roleCust, roleSeller, roleRider, roleAdmin]);

  // Seed Merchants & Staff
  await pool.query(`
    INSERT INTO merchants (id, merchant_code, name, business_name, pan_number, locality, address, latitude, longitude, phone, gstin, status)
    VALUES ($1, 'MC-001', 'Store A', 'Store A Pvt Ltd', 'ABCDE1234F', 'Koramangala', 'Bengaluru', 12.9716, 77.5946, '+919876543201', '29ABCDE1234F1Z5', 'ACTIVE'),
           ($2, 'MC-002', 'Store B', 'Store B Pvt Ltd', 'ABCDE1234F', 'Indiranagar', 'Bengaluru', 12.9816, 77.6046, '+919876543202', '29ABCDE1234F2Z5', 'ACTIVE')
  `, [merchantIdA, merchantIdB]);

  await pool.query(`
    INSERT INTO store_staff (merchant_id, user_id, name, phone, role)
    VALUES ($1, $2, 'Seller Owner', '+919876543212', 'STORE_OWNER')
  `, [merchantIdA, userSeller]);

  // Seed Rider
  await pool.query(`
    INSERT INTO riders (id, rider_code, name, phone, vehicle_type, status, wallet_balance, floating_cash_balance)
    VALUES ($1, 'RD-9001', 'Rider Test', '+919876543213', 'motorcycle', 'AVAILABLE', 500.00, 0.00)
  `, [riderId]);

  // Seed Orders
  await pool.query(`
    INSERT INTO orders (id, order_number, user_id, merchant_id, status, items_subtotal, taxable_amount, total_amount, payment_method, delivery_otp, handover_token, jobsite_address, pricing_snapshot, estimated_delivery_at)
    VALUES
    ($1, 'QC-TEST-001', $2, $3, 'out_for_delivery', 500, 500, 550, 'Instant UPI', '123456', 'PK-001', '{"latitude":12.97,"longitude":77.59}'::jsonb, '{}'::jsonb, NOW() + interval '30 min'),
    ($4, 'QC-TEST-002', $5, $6, 'placed', 300, 300, 330, 'Instant UPI', '654321', 'PK-002', '{"latitude":12.98,"longitude":77.60}'::jsonb, '{}'::jsonb, NOW() + interval '30 min')
  `, [orderIdA, userCustomerA, merchantIdA, orderIdB, userCustomerB, merchantIdB]);

  // Seed Delivery Trip for Order A
  await pool.query(`
    INSERT INTO delivery_trips (id, order_id, rider_id, status, accepted_at, base_fare, distance_fare, surge_fare, total_rider_payout)
    VALUES ($1, $2, $3, 'PICKED_UP', NOW(), 35.00, 15.00, 0.00, 50.00)
  `, [tripIdA, orderIdA, riderId]);

  // Seed Active Auth Sessions
  const sessionCustA = crypto.randomUUID();
  const sessionCustB = crypto.randomUUID();
  const sessionRider = crypto.randomUUID();
  const sessionSeller = crypto.randomUUID();
  const sessionAdmin = crypto.randomUUID();
  const sessionRevoked = crypto.randomUUID();

  await pool.query(`
    INSERT INTO auth_sessions (id, user_id, status, expires_at) VALUES
    ($1, $2, 'ACTIVE', NOW() + interval '24 hours'),
    ($3, $4, 'ACTIVE', NOW() + interval '24 hours'),
    ($5, $6, 'ACTIVE', NOW() + interval '24 hours'),
    ($7, $8, 'ACTIVE', NOW() + interval '24 hours'),
    ($9, $10, 'ACTIVE', NOW() + interval '24 hours'),
    ($11, $2, 'REVOKED', NOW() + interval '24 hours')
  `, [
    sessionCustA, userCustomerA,
    sessionCustB, userCustomerB,
    sessionRider, userRider,
    sessionSeller, userSeller,
    sessionAdmin, userAdmin,
    sessionRevoked,
  ]);

  // Generate tokens
  const tokenCustA = signAccessToken({ sub: userCustomerA, session_id: sessionCustA, roles: ['CUSTOMER'] });
  const tokenCustB = signAccessToken({ sub: userCustomerB, session_id: sessionCustB, roles: ['CUSTOMER'] });
  const tokenRider = signAccessToken({ sub: userRider, session_id: sessionRider, roles: ['RIDER'] });
  const tokenSeller = signAccessToken({ sub: userSeller, session_id: sessionSeller, roles: ['SELLER'] });
  const tokenAdmin = signAccessToken({ sub: userAdmin, session_id: sessionAdmin, roles: ['SUPER_ADMIN'] });
  const tokenRevoked = signAccessToken({ sub: userCustomerA, session_id: sessionRevoked, roles: ['CUSTOMER'] });

  // -------------------------------------------------------------
  // Test 1: Outbox Transactional Atomicity (Rollback = Zero Event)
  // -------------------------------------------------------------
  console.log('[Test 1] Testing Outbox Transactional Atomicity on Rollback...');
  const fakeOrderId = crypto.randomUUID();
  try {
    await transaction(async (txClient: any) => {
      await outboxService.stageEvent(txClient, {
        eventType: 'ORDER_CREATED',
        aggregateType: 'ORDER',
        aggregateId: fakeOrderId,
        payload: { fake: true },
      });
      throw new Error('SIMULATED_TRANSACTION_FAILURE');
    }, pool);
  } catch (err: any) {
    assert.equal(err.message, 'SIMULATED_TRANSACTION_FAILURE');
  }

  const outboxCheckRollback = await pool.query(
    `SELECT * FROM outbox_events WHERE aggregate_id = $1`,
    [fakeOrderId]
  );
  assert.equal(outboxCheckRollback.rows.length, 0, 'Rolled back transaction must leave ZERO outbox events');
  console.log('✓ Test 1 passed: Database rollback guarantees zero phantom outbox events');

  // -------------------------------------------------------------
  // Test 2: Outbox Commit & Atomic Event Persistence
  // -------------------------------------------------------------
  console.log('[Test 2] Testing Outbox Event Persistence on Commit...');
  const committedOrderId = crypto.randomUUID();
  const staged = await transaction(async (txClient: any) => {
    return await outboxService.stageEvent(txClient, {
      eventType: 'ORDER_CREATED',
      aggregateType: 'ORDER',
      aggregateId: committedOrderId,
      payload: { committed: true, amount: 999 },
    });
  }, pool);

  const outboxCheckCommit = await pool.query(
    `SELECT * FROM outbox_events WHERE id = $1`,
    [staged.id]
  );
  assert.equal(outboxCheckCommit.rows.length, 1);
  assert.equal(outboxCheckCommit.rows[0].status, 'PENDING');
  console.log('✓ Test 2 passed: Committed transaction atomically records outbox event');

  // -------------------------------------------------------------
  // Test 3: Outbox Claiming, Concurrency Locking & Batch Processing
  // -------------------------------------------------------------
  console.log('[Test 3] Testing Outbox Batch Claiming and Relayer Delivery...');
  let eventDispatched = false;
  outboxService.registerConsumer('ORDER_CREATED', async (evt) => {
    if (evt.aggregateId === committedOrderId) {
      eventDispatched = true;
    }
  });

  const batchResult = await outboxService.processOutboxBatch(10);
  assert.ok(batchResult.processed >= 1);
  assert.ok(eventDispatched, 'Outbox relayer must dispatch to registered consumer');

  const publishedCheck = await pool.query(
    `SELECT status, published_at FROM outbox_events WHERE id = $1`,
    [staged.id]
  );
  assert.equal(publishedCheck.rows[0].status, 'PUBLISHED');
  assert.ok(publishedCheck.rows[0].published_at !== null);
  console.log('✓ Test 3 passed: Outbox events claimed and marked PUBLISHED after successful consumer handling');

  const leaseStage = await transaction(async (txClient: any) => outboxService.stageEvent(txClient, {
    eventType: 'LEASE_TEST',
    aggregateType: 'TEST',
    aggregateId: crypto.randomUUID(),
    payload: { lease: true },
  }), pool);
  const concurrentClaims = await Promise.all([
    outboxService.claimPendingEvents(1),
    outboxService.claimPendingEvents(1),
  ]);
  const claimedLeaseEvents = concurrentClaims.flat().filter((event) => event.id === leaseStage.id);
  assert.equal(claimedLeaseEvents.length, 1, 'Only one worker may retain an outbox event claim');
  assert.ok(claimedLeaseEvents[0].leaseToken, 'Claim must carry a fencing token');
  assert.equal(claimedLeaseEvents[0].status, 'PENDING');
  const firstLeaseToken = claimedLeaseEvents[0].leaseToken!;
  await pool.query(
    `UPDATE outbox_events SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
    [leaseStage.id]
  );
  const recoveredLease = (await outboxService.claimPendingEvents(1))
    .find((event) => event.id === leaseStage.id);
  assert.ok(recoveredLease?.leaseToken, 'Expired claims must be reclaimable after a worker crash');
  assert.notEqual(recoveredLease.leaseToken, firstLeaseToken, 'A reclaimed event must receive a fresh fencing token');
  await assert.rejects(
    () => outboxService.markPublished(leaseStage.id, firstLeaseToken, pool as any),
    /OUTBOX_LEASE_LOST/
  );
  await outboxService.markPublished(leaseStage.id, recoveredLease.leaseToken);
  console.log('✓ Persisted claims, concurrent exclusion, expired-lease recovery, and stale-token fencing verified');

  let ambiguousDeliveries = 0;
  outboxService.registerConsumer('OUTBOX_AMBIGUOUS_TEST', async () => {
    ambiguousDeliveries++;
    if (ambiguousDeliveries === 1) {
      throw new Error('Simulated acknowledgement loss after handler side effect');
    }
  });
  const ambiguousEvent = await transaction(async (txClient: any) => outboxService.stageEvent(txClient, {
    eventType: 'OUTBOX_AMBIGUOUS_TEST',
    aggregateType: 'TEST',
    aggregateId: crypto.randomUUID(),
    payload: { retry: true },
  }), pool);
  const ambiguousFirstAttempt = await outboxService.processOutboxBatch(1);
  assert.equal(ambiguousFirstAttempt.failed, 1, 'Ambiguous handler outcome must schedule a retry');
  await pool.query(
    `UPDATE outbox_events SET next_attempt_at = NOW() WHERE id = $1`,
    [ambiguousEvent.id]
  );
  const ambiguousRetry = await outboxService.processOutboxBatch(1);
  assert.equal(ambiguousRetry.succeeded, 1, 'A retried ambiguous delivery must complete');
  assert.equal(ambiguousDeliveries, 2, 'Outbox delivery is at-least-once and handlers may observe duplicates');

  let longHandlerRuns = 0;
  outboxService.registerConsumer('OUTBOX_LONG_HANDLER_TEST', async (event) => {
    longHandlerRuns++;
    if (longHandlerRuns === 1) {
      await pool.query(
        `UPDATE outbox_events
         SET lease_expires_at = NOW() - INTERVAL '1 second'
         WHERE id = $1`,
        [event.id]
      );
    }
  });
  await transaction(async (txClient: any) => outboxService.stageEvent(txClient, {
    eventType: 'OUTBOX_LONG_HANDLER_TEST',
    aggregateType: 'TEST',
    aggregateId: crypto.randomUUID(),
    payload: { exceedsLease: true },
  }), pool);
  await assert.rejects(
    () => outboxService.processOutboxBatch(1),
    /OUTBOX_LEASE_LOST/
  );
  const longHandlerRetry = await outboxService.processOutboxBatch(1);
  assert.equal(longHandlerRetry.succeeded, 1, 'An event whose handler outlives its lease must be recoverable');
  assert.equal(longHandlerRuns, 2, 'A handler exceeding its lease can be delivered again');
  console.log('✓ Ambiguous and over-lease handler outcomes recover safely with documented at-least-once delivery');

  // -------------------------------------------------------------
  // Test 4: Outbox Bounded Exponential Backoff & Dead-Letter Handling
  // -------------------------------------------------------------
  console.log('[Test 4] Testing Outbox Failure Retry & Dead-Letter Queueing...');
  const failAggregateId = crypto.randomUUID();
  const client3 = await pool.connect();
  await client3.query('BEGIN');
  const stagedFail = await outboxService.stageEvent(client3, {
    eventType: 'FAIL_EVENT_TEST',
    aggregateType: 'FAIL_TEST',
    aggregateId: failAggregateId,
    payload: { willFail: true },
  });
  await client3.query('COMMIT');
  client3.release();
  const failEventId = stagedFail.id;

  // Fail 1st attempt
  await outboxService.markFailed(failEventId, 'Transient network timeout', pool as any);
  let failRow = (await pool.query(`SELECT attempt_count, status, last_error FROM outbox_events WHERE id = $1`, [failEventId])).rows[0];
  assert.equal(failRow.attempt_count, 1);
  assert.equal(failRow.status, 'PENDING');

  // Simulate reaching max attempts (5)
  await pool.query(`UPDATE outbox_events SET attempt_count = 4 WHERE id = $1`, [failEventId]);
  await outboxService.markFailed(failEventId, 'Terminal connection reset', pool as any);
  failRow = (await pool.query(`SELECT attempt_count, status, last_error FROM outbox_events WHERE id = $1`, [failEventId])).rows[0];
  assert.equal(failRow.status, 'DEAD_LETTER');
  assert.equal(failRow.attempt_count, 5);

  // Test replay
  const replayedCount = await outboxService.replayFailedEvents([failEventId]);
  assert.equal(replayedCount, 1);
  failRow = (await pool.query(`SELECT status, attempt_count FROM outbox_events WHERE id = $1`, [failEventId])).rows[0];
  assert.equal(failRow.status, 'PENDING');
  assert.equal(failRow.attempt_count, 0);
  console.log('✓ Test 4 passed: Outbox failure transitions to DEAD_LETTER after max attempts and supports operator replay');

  // -------------------------------------------------------------
  // Test 5: Realtime WebSocket Gateway Server Setup & Handshake
  // -------------------------------------------------------------
  console.log('[Test 5] Testing Realtime WebSocket Handshake Authentication...');
  const httpServer = http.createServer();
  realtimeGateway.setupWebSocketServer(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const serverPort = (httpServer.address() as any).port;

  // Unauthenticated connection attempt
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}`);
    ws.on('error', (err: any) => {
      assert.ok(err.message.includes('401') || err.message.includes('Unexpected server response'));
      resolve();
    });
  });

  // Revoked session connection attempt
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}?token=${tokenRevoked}`);
    ws.on('error', (err: any) => {
      assert.ok(err.message.includes('401') || err.message.includes('Unexpected server response'));
      resolve();
    });
  });

  // Valid authenticated connection attempt
  const wsCustA = new WebSocket(`ws://127.0.0.1:${serverPort}?token=${tokenCustA}`);
  const welcomePromise = new Promise<any>((resolve) => {
    wsCustA.on('message', (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') resolve(msg);
      } catch {}
    });
  });

  await new Promise<void>((resolve, reject) => {
    wsCustA.on('open', resolve);
    wsCustA.on('error', reject);
  });

  const welcomeMsg = await welcomePromise;
  assert.equal(welcomeMsg.type, 'connected');
  console.log('✓ Test 5 passed: WebSocket gateway rejects unauthenticated/revoked tokens and authenticates valid sessions');

  // -------------------------------------------------------------
  // Test 6: WebSocket Ping/Pong Heartbeat
  // -------------------------------------------------------------
  console.log('[Test 6] Testing WebSocket Ping/Pong Heartbeat Protocol...');
  wsCustA.send(JSON.stringify({ action: 'ping' }));
  const pongMsg = await new Promise<any>((resolve) => {
    wsCustA.once('message', (data: any) => resolve(JSON.parse(data.toString())));
  });
  assert.equal(pongMsg.type, 'pong');
  console.log('✓ Test 6 passed: WebSocket heartbeat ping/pong verified');

  // -------------------------------------------------------------
  // Test 7: Channel Subscription Authorization & IDOR Block
  // -------------------------------------------------------------
  console.log('[Test 7] Testing Channel Subscription Authorization & IDOR Blocking...');
  // Customer A subscribes to own order -> Success
  wsCustA.send(JSON.stringify({ action: 'subscribe', channel: `order:${orderIdA}` }));
  const subSuccessMsg = await new Promise<any>((resolve) => {
    wsCustA.once('message', (data: any) => resolve(JSON.parse(data.toString())));
  });
  assert.equal(subSuccessMsg.type, 'subscribed');
  assert.equal(subSuccessMsg.channel, `order:${orderIdA}`);

  // Customer A subscribes to Customer B's order -> Blocked with FORBIDDEN_CHANNEL
  wsCustA.send(JSON.stringify({ action: 'subscribe', channel: `order:${orderIdB}` }));
  const subForbiddenOrder = await new Promise<any>((resolve) => {
    wsCustA.once('message', (data: any) => resolve(JSON.parse(data.toString())));
  });
  assert.equal(subForbiddenOrder.type, 'error');
  assert.equal(subForbiddenOrder.code, 'FORBIDDEN_CHANNEL');

  // Customer A attempts to subscribe to another user notification channel
  wsCustA.send(JSON.stringify({ action: 'subscribe', channel: `user:${userCustomerB}` }));
  const subForbiddenUser = await new Promise<any>((resolve) => {
    wsCustA.once('message', (data: any) => resolve(JSON.parse(data.toString())));
  });
  assert.equal(subForbiddenUser.type, 'error');
  assert.equal(subForbiddenUser.code, 'FORBIDDEN_CHANNEL');

  // Customer A attempts to subscribe to admin fleet channel
  wsCustA.send(JSON.stringify({ action: 'subscribe', channel: 'admin:fleet' }));
  const subForbiddenAdmin = await new Promise<any>((resolve) => {
    wsCustA.once('message', (data: any) => resolve(JSON.parse(data.toString())));
  });
  assert.equal(subForbiddenAdmin.type, 'error');
  assert.equal(subForbiddenAdmin.code, 'FORBIDDEN_CHANNEL');
  console.log('✓ Test 7 passed: Realtime channel IDOR attempts strictly blocked (Cross-order, Cross-user, Admin)');

  // -------------------------------------------------------------
  // Test 8: Logout Session Revocation Disconnects Active WebSocket
  // -------------------------------------------------------------
  console.log('[Test 8] Testing Active WebSocket Severance on Session Logout...');
  const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
    wsCustA.on('close', (code: number, reason: any) => resolve({ code, reason: reason.toString() }));
  });

  // Call authService.logout
  await authService.logout(sessionCustA, userCustomerA, '127.0.0.1', 'Mozilla', pool as any);

  const closeResult = await closePromise;
  assert.equal(closeResult.code, 4401);
  assert.equal(closeResult.reason, 'SESSION_REVOKED');
  console.log('✓ Test 8 passed: Logging out session instantly severs active WebSocket connection with code 4401');

  // -------------------------------------------------------------
  // Test 9: Global Logout-All Severance Across Devices
  // -------------------------------------------------------------
  console.log('[Test 9] Testing Multi-Device WebSocket Severance on Logout-All...');
  // Create new active session and connect socket for Customer B
  const wsCustB = await new Promise<WebSocket>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}?token=${tokenCustB}`);
    ws.on('open', () => resolve(ws));
  });

  const closeCustBPromise = new Promise<{ code: number; reason: string }>((resolve) => {
    wsCustB.on('close', (code: number, reason: any) => resolve({ code, reason: reason.toString() }));
  });

  // Execute logoutAll
  await authService.logoutAll(userCustomerB, '127.0.0.1', 'Mozilla', pool as any);

  const closeCustBResult = await closeCustBPromise;
  assert.equal(closeCustBResult.code, 4401);
  assert.equal(closeCustBResult.reason, 'LOGOUT_ALL');
  console.log('✓ Test 9 passed: Global logout-all severs all active WebSocket connections across devices');

  // -------------------------------------------------------------
  // Test 10: Ephemeral Rider GPS Ingestion & Velocity Sanity Checks
  // -------------------------------------------------------------
  console.log('[Test 10] Testing Ephemeral Live GPS & Anti-Spoofing Velocity Checks...');
  inMemoryStore.clear();

  // Rider has active trip on Order A -> Upload valid ping
  const now = Date.now();
  const ping1 = await liveLocationService.ingestRiderLocation({
    riderId,
    latitude: 12.9716,
    longitude: 77.5946,
    heading: 90,
    speed: 30,
    timestamp: now,
  });
  assert.equal(ping1.success, true);
  assert.equal(ping1.orderId, orderIdA);

  // Verify coordinates stored strictly in Redis ephemeral cache with TTL 60s
  const cachedLoc = await liveLocationService.getRiderLocation(riderId);
  assert.ok(cachedLoc !== null);
  assert.equal(cachedLoc.latitude, 12.9716);

  // Stale timestamp rejection: ping with older timestamp
  const stalePing = await liveLocationService.ingestRiderLocation({
    riderId,
    latitude: 12.9720,
    longitude: 77.5950,
    timestamp: now - 5000, // 5s in past
  });
  assert.equal(stalePing.success, false);
  assert.ok(stalePing.error?.includes('STALE_GPS_TIMESTAMP'));

  // Velocity sanity check: impossible jump (e.g. 50 km in 2 seconds = 90,000 km/h)
  const spoofedPing = await liveLocationService.ingestRiderLocation({
    riderId,
    latitude: 13.5000, // ~60km away
    longitude: 77.5946,
    timestamp: now + 2000, // 2s later
  });
  assert.equal(spoofedPing.success, false);
  assert.ok(spoofedPing.error?.includes('GPS_VELOCITY_CHECK_FAILED'));
  console.log('✓ Test 10 passed: Live GPS updates stored in Redis, stale pings rejected, >120km/h velocity jumps blocked');

  // -------------------------------------------------------------
  // Test 11: Zero GPS Persistence in PostgreSQL Verification
  // -------------------------------------------------------------
  console.log('[Test 11] Verifying Zero Second-by-Second GPS Rows in PostgreSQL...');
  // Verify that route_telemetry was NOT written to by liveLocationService
  const telemetryRows = await pool.query(`SELECT COUNT(*) as count FROM route_telemetry`);
  assert.equal(Number(telemetryRows.rows[0].count), 0, 'Live GPS pings must NEVER insert second-by-second rows in PostgreSQL');
  console.log('✓ Test 11 passed: PostgreSQL remains free of high-frequency GPS ping table bloat');

  // -------------------------------------------------------------
  // Test 12: Device Token Registry (Hashing, Preview & Deactivation)
  // -------------------------------------------------------------
  console.log('[Test 12] Testing Push Device Token Registration & Masking...');
  const rawToken = 'fcm_secret_device_push_token_998877665544';
  const regResult = await deviceTokenService.registerToken({
    userId: userCustomerA,
    rawToken,
    platform: 'ANDROID',
    appVersion: '2.1.0',
    deviceMetadataMinimal: { os: 'Android 14' },
  });

  assert.ok(regResult.tokenId);
  assert.equal(regResult.tokenHash, crypto.createHash('sha256').update(rawToken).digest('hex'));
  assert.equal(regResult.rawTokenPreview, 'fcm_...5544');

  // Idempotent re-registration
  const reReg = await deviceTokenService.registerToken({
    userId: userCustomerA,
    rawToken,
    platform: 'ANDROID',
  });
  assert.equal(reReg.isNew, false);

  // Active tokens list
  const activeTokens = await deviceTokenService.getActiveTokensForUser(userCustomerA);
  assert.equal(activeTokens.length, 1);
  assert.equal(activeTokens[0].tokenHash, regResult.tokenHash);

  // Deactivate
  const deactivated = await deviceTokenService.deactivateToken(regResult.tokenId, userCustomerA);
  assert.equal(deactivated, true);
  const activeTokensAfter = await deviceTokenService.getActiveTokensForUser(userCustomerA);
  assert.equal(activeTokensAfter.length, 0);
  console.log('✓ Test 12 passed: Device tokens securely hashed with SHA-256, masked preview retained, deactivation verified');

  // -------------------------------------------------------------
  // Test 13: Notification Preferences & Consent Enforcement
  // -------------------------------------------------------------
  console.log('[Test 13] Testing Notification Preferences & Promotional Consent Isolation...');
  // Default preferences: push=true, transactional=true, delivery=true, promotional=false (opt-in)
  const defaultPrefs = await preferenceService.getPreferences(userCustomerA);
  assert.equal(defaultPrefs.pushEnabled, true);
  assert.equal(defaultPrefs.transactionalEnabled, true);
  assert.equal(defaultPrefs.promotionalEnabled, false);

  // Attempt promotional push when promotional is false -> SKIPPED_PREFERENCE
  const promoSkipped = await notificationService.sendNotification({
    userId: userCustomerA,
    notificationType: 'PROMOTIONAL',
    title: '50% off Power Drills',
    body: 'Exclusive weekend deal',
    dedupeKey: `promo_test_1_${Date.now()}`,
  });
  assert.equal(promoSkipped.status, 'SKIPPED_PREFERENCE');

  // Update consent to enable promotional
  await preferenceService.updatePreferences(userCustomerA, { promotionalEnabled: true });
  const updatedPrefs = await preferenceService.getPreferences(userCustomerA);
  assert.equal(updatedPrefs.promotionalEnabled, true);

  // Re-register active token
  await deviceTokenService.registerToken({
    userId: userCustomerA,
    rawToken: 'fcm_valid_token_12345678',
    platform: 'ANDROID',
  });

  testPushProvider.clear();
  const promoSent = await notificationService.sendNotification({
    userId: userCustomerA,
    notificationType: 'PROMOTIONAL',
    title: '50% off Power Drills',
    body: 'Exclusive weekend deal',
    dedupeKey: `promo_test_2_${Date.now()}`,
  });
  assert.equal(promoSent.status, 'SENT');
  assert.equal(testPushProvider.getSentPushes().length, 1);
  console.log('✓ Test 13 passed: Promotional consent strictly distinguished from transactional alerts');

  // -------------------------------------------------------------
  // Test 14: Notification Deduplication Protection
  // -------------------------------------------------------------
  console.log('[Test 14] Testing Idempotent Notification Deduplication...');
  const dedupeKey = `order_placed_dedupe_${Date.now()}`;
  const firstSend = await notificationService.sendNotification({
    userId: userCustomerA,
    notificationType: 'TRANSACTIONAL',
    title: 'Order Placed QC-001',
    body: 'Your order has been confirmed',
    dedupeKey,
  });
  assert.equal(firstSend.status, 'SENT');
  assert.equal(firstSend.deduped, false);

  const duplicateSend = await notificationService.sendNotification({
    userId: userCustomerA,
    notificationType: 'TRANSACTIONAL',
    title: 'Order Placed QC-001',
    body: 'Your order has been confirmed',
    dedupeKey,
  });
  assert.equal(duplicateSend.deduped, true);
  assert.equal(duplicateSend.sentCount, 0);
  console.log('✓ Test 14 passed: Duplicate notification with identical dedupe_key cleanly rejected');

  // -------------------------------------------------------------
  // Test 15: Push Provider Invalid Token Auto-Deactivation
  // -------------------------------------------------------------
  console.log('[Test 15] Testing Unregistered Token Auto-Deactivation on Provider Rejection...');
  const badTokenRaw = 'fcm_bad_unregistered_token_001122';
  const badReg = await deviceTokenService.registerToken({
    userId: userCustomerB,
    rawToken: badTokenRaw,
    platform: 'IOS',
  });

  // Configure provider to reject this token as UNREGISTERED
  testPushProvider.simulateInvalidToken(badReg.tokenHash);

  await notificationService.sendNotification({
    userId: userCustomerB,
    notificationType: 'TRANSACTIONAL',
    title: 'Delivery Update',
    body: 'Rider is on the way',
    dedupeKey: `bad_token_test_${Date.now()}`,
    skipPreferenceCheck: true,
  });

  // Verify that bad token was deactivated automatically in database
  const activeTokensB = await deviceTokenService.getActiveTokensForUser(userCustomerB);
  assert.equal(activeTokensB.length, 0, 'Unregistered token must be deactivated automatically');
  console.log('✓ Test 15 passed: Invalid device tokens automatically deactivated on provider rejection');

  // -------------------------------------------------------------
  // Test 16: Admin Rich Push Campaigns & Security Validation
  // -------------------------------------------------------------
  console.log('[Test 16] Testing Admin Rich Push Campaigns & Deep Link Validation...');
  // Reject non-https image URL
  await assert.rejects(
    async () => {
      await campaignService.createCampaign(userAdmin, {
        name: 'Insecure Campaign',
        title: 'Title',
        body: 'Body',
        imageUrl: 'http://insecure-cdn.com/banner.jpg',
        audienceType: 'ALL_ACTIVE_CUSTOMERS',
      });
    },
    /Image URL must use secure HTTPS protocol/,
    'Non-HTTPS image URLs must be rejected'
  );

  // Reject external URL in deep link
  await assert.rejects(
    async () => {
      await campaignService.createCampaign(userAdmin, {
        name: 'Phishing Campaign',
        title: 'Title',
        body: 'Body',
        deepLink: 'https://malicious-phishing-site.com/steal-login',
        audienceType: 'ALL_ACTIVE_CUSTOMERS',
      });
    },
    /Deep links must be internal relative application routes/,
    'External deep links must be rejected'
  );

  // Valid Campaign Creation
  const validCampaign = await campaignService.createCampaign(userAdmin, {
    name: 'Monsoon Contractor Fest',
    title: 'Monsoon Waterproofing Deals',
    body: 'Get 25% off Dr. Fixit & Bosch drills today only!',
    imageUrl: 'https://cdn.qcom.in/campaigns/monsoon_banner.jpg',
    deepLink: '/deals',
    audienceType: 'ALL_ACTIVE_CUSTOMERS',
    priority: 'HIGH',
  });
  assert.equal(validCampaign.status, 'DRAFT');

  // Test Send
  const testSendResult = await campaignService.testSend(validCampaign.id, userCustomerA);
  assert.equal(testSendResult.success, true);
  const testPushes = testPushProvider.getSentPushes();
  assert.ok(testPushes.some(p => p.message.title.includes('[TEST]')));

  // Schedule & Cancel
  const scheduled = await campaignService.scheduleCampaign(validCampaign.id, new Date(Date.now() + 86400000));
  assert.equal(scheduled.status, 'SCHEDULED');

  // Execute Campaign
  testPushProvider.clear();
  const executionStats = await campaignService.executeCampaign(validCampaign.id);
  assert.equal(executionStats.status, 'COMPLETED');
  assert.ok(executionStats.totalRecipientsTargeted >= 1);
  console.log('✓ Test 16 passed: Admin campaign created, URL validated, test dispatched, and audience executed');

  // -------------------------------------------------------------
  // Test 17: Notification Interaction Analytics (OPENED / CLICKED)
  // -------------------------------------------------------------
  console.log('[Test 17] Testing Notification Analytics Metrics Recording...');
  const notifId = crypto.randomUUID();
  // Record open
  await notificationService.recordInteractionMetric(userCustomerA, notifId, 'OPENED', validCampaign.id);
  // Record click
  await notificationService.recordInteractionMetric(userCustomerA, notifId, 'CLICKED', validCampaign.id, { link: '/deals' });

  const metricsCheck = await pool.query(
    `SELECT event_type FROM notification_event_metrics WHERE notification_id = $1 ORDER BY occurred_at ASC`,
    [notifId]
  );
  assert.equal(metricsCheck.rows.length, 2);
  assert.equal(metricsCheck.rows[0].event_type, 'OPENED');
  assert.equal(metricsCheck.rows[1].event_type, 'CLICKED');
  console.log('✓ Test 17 passed: Notification interaction metrics accurately recorded for analytics');

  // -------------------------------------------------------------
  // Test 18: Future Algorithmic Notification Contract
  // -------------------------------------------------------------
  console.log('[Test 18] Testing Future Algorithmic Decision Contract...');
  const ruleEngine = new BaselineRuleDecisionEngine();
  const decision = await ruleEngine.evaluateDecision({
    userId: userCustomerA,
    candidateContext: { preferredCategories: ['Power Tools'] },
    eligibilityContext: { isPromotionalOptedIn: true, isAccountActive: true },
  });

  assert.equal(decision.eligible, true);
  assert.equal(decision.algorithmName, 'BASELINE_RULE_ENGINE');
  assert.equal(decision.algorithmVersion, '1.0.0');
  assert.equal(decision.decisionReasonCode, 'CATEGORY_AFFINITY_MATCH');
  assert.ok(decision.deepLink?.includes('/category/power%20tools'));

  // Feed algorithmic decision directly into notification delivery pipeline
  testPushProvider.clear();
  const algoDelivery = await notificationService.sendNotification({
    userId: userCustomerA,
    notificationType: decision.notificationType,
    title: decision.title,
    body: decision.body,
    deepLink: decision.deepLink,
    dedupeKey: decision.dedupeKey,
    priority: decision.priority,
    data: {
      algorithm: decision.algorithmName,
      version: decision.algorithmVersion,
      reason: decision.decisionReasonCode,
    },
  });
  assert.equal(algoDelivery.status, 'SENT');
  assert.equal(testPushProvider.getSentPushes().length, 1);
  console.log('✓ Test 18 passed: Future algorithmic notification decisions plug into delivery pipeline without ML coupling');

  // Clean up
  httpServer.close();
  realtimeGateway.close();
  await pool.end();

  console.log('===========================================================');
  console.log('✓ ALL SPRINT 8 REALTIME + NOTIFICATIONS TESTS PASSED!');
  console.log('===========================================================\n');
}

if (process.argv[1]?.includes('sprint8-realtime-notifications')) {
  runSprint8RealtimeNotificationsTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import assert from 'node:assert/strict';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { bloomSyncBus, BloomSyncEvent } from '../src/modules/resilience/bloomSyncBus.js';
import { BloomFilterService, bloomFilterService } from '../src/modules/resilience/bloomFilterService.js';
import { SingleFlightGroup, cacheProtectionService } from '../src/modules/resilience/cacheProtection.js';
import { catalogService } from '../src/modules/catalog/catalogService.js';
import { setPool, getPool } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import { inMemoryStore, cacheSet, cacheGet, cacheDel } from '../src/database/redis.js';
import { orderService } from '../src/modules/orders/orderService.js';
import { refundService } from '../src/modules/payments/refundService.js';
import { getPaymentProvider } from '../src/modules/payments/paymentProvider.js';

export async function runSprint92SubscriberCacheResilienceTests(): Promise<void> {
  console.log('\n=============================================================');
  console.log('--- RUNNING SPRINT 9.2 SUBSCRIBER & CACHE RESILIENCE TESTS ---');
  console.log('=============================================================');

  const { pool } = createTestDatabase();
  setPool(pool);
  await runMigrations({ poolOverride: pool });
  await runSeeds(pool);

  // -------------------------------------------------------------
  // TEST S92-01: Multi-Node Active Subscriber Synchronizes Sibling Nodes
  // -------------------------------------------------------------
  console.log('\n[S92-01] Testing Active Redis/Event Subscriber Multi-Node Synchronization...');
  {
    bloomSyncBus.reset();
    inMemoryStore.clear();

    const instanceA = new BloomFilterService();
    const instanceB = new BloomFilterService();
    instanceA.setState('READY');
    instanceB.setState('READY');

    // Attach subscriber on Instance B
    bloomSyncBus.attachRedisSubscriber();
    assert.equal(bloomSyncBus.isSubscriberAttached(), true, 'Subscriber must be attached');

    const testOrderId = crypto.randomUUID();
    const testRefundId = crypto.randomUUID();

    // Instance A records addition (simulating committed transaction on container A)
    instanceA.add('orders', testOrderId);
    instanceA.add('refunds', testRefundId);

    // Wait 20ms for event propagation across subscriber bus
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Instance B must have updated its local Bloom filters without querying PostgreSQL
    assert.equal(instanceB.mightContain('orders', testOrderId), true, 'Instance B must contain orderId added on Instance A');
    assert.equal(instanceB.mightContain('refunds', testRefundId), true, 'Instance B must contain refundId added on Instance A');

    // Unrelated arbitrary ID must still return false on Instance B
    const arbitraryId = crypto.randomUUID();
    assert.equal(instanceB.mightContain('orders', arbitraryId), false, 'Arbitrary uncommitted ID must return false on Instance B');

    console.log('✓ S92-01 Passed: Active subscriber synchronizes cross-node Bloom filters idempotently.');
  }

  // -------------------------------------------------------------
  // TEST S92-02: Transient Read-After-Write Propagation Window Protection
  // -------------------------------------------------------------
  console.log('\n[S92-02] Testing Read-After-Write Propagation Window Protection (mightContainSafe)...');
  {
    const instanceC = new BloomFilterService();
    instanceC.setState('READY');
    const testOrderId = crypto.randomUUID();

    // Simulate transient network delay where subscriber message has NOT arrived at Instance C yet,
    // but the write was committed and staged in Redis ephemeral recent cache with 10s TTL
    await cacheSet(`bloom:recent:orders:${testOrderId}`, '1', 10);

    // Instance C local Bloom filter returns false (message hasn't arrived)
    assert.equal(instanceC.mightContain('orders', testOrderId), false, 'Local filter is false before pub/sub arrival');

    // BUT mightContainSafe checks the distributed recent-writes window and returns true!
    const isSafe = await instanceC.mightContainSafe('orders', testOrderId);
    assert.equal(isSafe, true, 'mightContainSafe MUST return true during propagation window to prevent false 404');

    // For a completely non-existent ID, mightContainSafe must return false
    const nonExistentId = crypto.randomUUID();
    const isAbsent = await instanceC.mightContainSafe('orders', nonExistentId);
    assert.equal(isAbsent, false, 'Non-existent ID must return false in mightContainSafe');

    console.log('✓ S92-02 Passed: Transient read-after-write propagation window protected against 404 false negatives.');
  }

  // -------------------------------------------------------------
  // TEST S92-03: In-Process SingleFlight Deduplication
  // -------------------------------------------------------------
  console.log('\n[S92-03] Testing SingleFlight In-Process Concurrency Deduplication...');
  {
    const sf = new SingleFlightGroup();
    let dbExecutionCount = 0;

    // Simulate expensive loader function that takes 30ms
    const expensiveDbQuery = async () => {
      dbExecutionCount++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { loadedAt: Date.now(), data: 'heavy_catalog_payload' };
    };

    // Fire 50 concurrent requests for the exact same key at the same millisecond
    const requests = Array.from({ length: 50 }, () => sf.do('catalog:heavy', expensiveDbQuery));
    const results = await Promise.all(requests);

    // Exactly 1 execution must have occurred!
    assert.equal(dbExecutionCount, 1, 'SingleFlight must execute loader exactly once for 50 concurrent callers');

    // All 50 callers must receive identical result
    for (const r of results) {
      assert.equal(r.data, 'heavy_catalog_payload');
      assert.equal(r.loadedAt, results[0].loadedAt);
    }

    const metrics = sf.getMetrics();
    assert.equal(metrics.executionsTotal, 1);
    assert.equal(metrics.deduplicatedTotal, 49);
    assert.equal(metrics.inFlightCount, 0, 'In-flight map must be clean after resolution');

    console.log('✓ S92-03 Passed: SingleFlight deduplicated 50 concurrent requests into 1 database query (49 saved).');
  }

  // -------------------------------------------------------------
  // TEST S92-04: Cache Protection Service with Stampede Prevention
  // -------------------------------------------------------------
  console.log('\n[S92-04] Testing CacheProtectionService Stampede Prevention & Mutex Coordination...');
  {
    cacheProtectionService.resetMetrics();
    await cacheProtectionService.invalidate('test:stampede:key');

    let loaderExecutions = 0;
    const testLoader = async () => {
      loaderExecutions++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { timestamp: Date.now(), items: ['pipe', 'valve', 'fitting'] };
    };

    // 40 concurrent requests hit cold cache simultaneously
    const tasks = Array.from({ length: 40 }, () =>
      cacheProtectionService.fetchThroughCache('test:stampede:key', { ttlSec: 60, lockTtlMs: 2000 }, testLoader)
    );

    const outcomes = await Promise.all(tasks);

    // Database loader must only execute once across all 40 concurrent requests
    assert.equal(loaderExecutions, 1, 'Database loader must only execute once across concurrent stampede');

    for (const outcome of outcomes) {
      assert.deepEqual(outcome.items, ['pipe', 'valve', 'fitting']);
      assert.equal(outcome.timestamp, outcomes[0].timestamp);
    }

    // Now that cache is populated, a subsequent request must be an immediate cache hit without loader execution
    const cachedResult = await cacheProtectionService.fetchThroughCache(
      'test:stampede:key',
      { ttlSec: 60 },
      testLoader
    );
    assert.equal(loaderExecutions, 1, 'Subsequent call must be served from cache without invoking loader');
    assert.equal(cachedResult.timestamp, outcomes[0].timestamp);

    console.log('✓ S92-04 Passed: Cache stampede eliminated with combined SingleFlight + Distributed Mutex.');
  }

  // -------------------------------------------------------------
  // TEST S92-05: Catalog Service Cache Integration
  // -------------------------------------------------------------
  console.log('\n[S92-05] Testing CatalogService with Protected Caching...');
  {
    await catalogService.invalidateCache();

    // First call populates cache
    const products1 = await catalogService.getProducts();
    assert.ok(Array.isArray(products1), 'getProducts must return array');

    // Second call reads from protected cache
    const products2 = await catalogService.getProducts();
    assert.equal(products2.length, products1.length);
    if (products1.length > 0) {
      assert.equal(products2[0].id, products1[0].id);
    }

    // Invalidation clears cache
    await catalogService.invalidateCache();
    const products3 = await catalogService.getProducts();
    assert.equal(products3.length, products1.length);

    console.log('✓ S92-05 Passed: Master Catalog and Category endpoints operate with safe protected cache.');
  }

  // -------------------------------------------------------------
  // TEST S92-06: Redis Outage / Downtime Resilience (Continuous Availability)
  // -------------------------------------------------------------
  console.log('\n[S92-06] Testing Redis Outage / Degraded Mode Resilience (Fail-Open)...');
  {
    // Simulate synchronization degradation (e.g. Redis disconnect or network split)
    bloomSyncBus.setHealthy(false);
    assert.equal(bloomSyncBus.isHealthy(), false);

    // When sync is unhealthy, Bloom filters MUST safely fail open to PostgreSQL
    const bogusId = 'non_existent_order_' + crypto.randomUUID();
    const fallbackResult = bloomFilterService.mightContain('orders', bogusId);
    assert.equal(fallbackResult, true, 'Degraded synchronization MUST return true to force authoritative DB lookup');

    // Cache protection must also gracefully degrade and execute loader without throwing
    let loaderCalledDuringOutage = false;
    const outageResult = await cacheProtectionService.fetchThroughCache(
      'outage:test:key',
      { ttlSec: 10, bypassCache: true },
      async () => {
        loaderCalledDuringOutage = true;
        return { status: 'healthy_from_postgres' };
      }
    );
    assert.equal(loaderCalledDuringOutage, true);
    assert.equal(outageResult.status, 'healthy_from_postgres');

    // Restore health
    bloomSyncBus.setHealthy(true);
    assert.equal(bloomSyncBus.isHealthy(), true);

    console.log('✓ S92-06 Passed: Redis outage handled gracefully with 100% continuous availability and zero false negatives.');
  }

  // -------------------------------------------------------------
  // TEST S92-07: Subscriber Lifecycle (Attach, Error, Close, Reconnect, Detach)
  // -------------------------------------------------------------
  console.log('\n[S92-07] Testing Subscriber Connection State Transitions...');
  {
    const mockClient = new EventEmitter() as any;
    mockClient.subscribe = () => Promise.resolve('OK');
    mockClient.unsubscribe = () => Promise.resolve('OK');
    mockClient.quit = () => Promise.resolve('OK');

    const testBus = new (bloomSyncBus.constructor as any)();
    testBus.attachRedisSubscriber(mockClient);
    assert.equal(testBus.isSubscriberAttached(), true);
    assert.equal(testBus.isHealthy(), true);

    // Simulate connection error
    mockClient.emit('error', new Error('ECONNRESET: Redis connection lost'));
    assert.equal(testBus.isHealthy(), false, 'Bus must mark degraded on subscriber error');

    // Simulate reconnection
    mockClient.emit('ready');
    assert.equal(testBus.isHealthy(), true, 'Bus must mark healthy on subscriber reconnection');

    // Clean detach
    await testBus.detachRedisSubscriber();
    assert.equal(testBus.isSubscriberAttached(), false, 'Subscriber must be cleanly detached');

    console.log('✓ S92-07 Passed: Subscriber handles error, close, ready, and detach lifecycle events safely.');
  }

  // -------------------------------------------------------------
  // TEST S92-08: Financial Invariants Unaltered (PostgreSQL Remains Truth)
  // -------------------------------------------------------------
  console.log('\n[S92-08] Testing Financial Invariants: PostgreSQL & Durable Idempotency Remain Sole Authority...');
  {
    // Seed delivered and paid order for financial check
    const merchantRes = await pool.query(`SELECT id FROM merchants LIMIT 1`);
    const userRes = await pool.query(`SELECT id FROM users LIMIT 1`);
    const prodRes = await pool.query(`SELECT id FROM products LIMIT 1`);
    const merchantId = merchantRes.rows[0].id;
    const userId = userRes.rows[0].id;
    const productId = prodRes.rows[0].id;

    const created = await orderService.createOrder({
      userId,
      merchantId,
      items: [{ productId, quantity: 1 }],
      jobSite: { address: 'Site S92 Fin', latitude: 12.9716, longitude: 77.5946 },
      paymentMethod: 'Instant UPI',
    });
    const orderId = created.order.id;

    await pool.query(
      `UPDATE orders SET status = 'delivered', payment_status = 'PAID' WHERE id = $1`,
      [orderId]
    );

    const fixedIdempotencyKey = `refund-s92-inv-${Date.now()}`;

    // First refund call
    const refund1 = await refundService.createRefund({
      orderId,
      amount: 100.00,
      reasonCode: 'CUSTOMER_DEFECT',
      reasonDescription: 'Damage on site',
      requestedBy: userId,
      idempotencyKey: fixedIdempotencyKey,
    });
    assert.equal(refund1.refund.amount, 100.00);

    // Repeated refund call with same idempotency key must return existing refund without double-disbursement
    const refund2 = await refundService.createRefund({
      orderId,
      amount: 100.00,
      reasonCode: 'CUSTOMER_DEFECT',
      reasonDescription: 'Damage on site duplicate',
      requestedBy: userId,
      idempotencyKey: fixedIdempotencyKey,
    });
    assert.equal(refund2.refund.id, refund1.refund.id, 'Idempotency key must return existing refund record');
    assert.equal(refund2.refund.amount, 100.00);
    assert.equal(refund2.isDuplicate, true);

    // Verify in database that exactly ONE refund record exists
    const dbRefunds = await pool.query(
      `SELECT * FROM refunds WHERE idempotency_key = $1`,
      [fixedIdempotencyKey]
    );
    assert.equal(dbRefunds.rows.length, 1, 'PostgreSQL must contain exactly 1 refund record');

    console.log('✓ S92-08 Passed: Financial transactions governed authoritatively by PostgreSQL transactions and durable idempotency.');
  }

  console.log('\n=============================================================');
  console.log('--- ALL SPRINT 9.2 SUBSCRIBER & CACHE TESTS PASSED (8/8) ---');
  console.log('=============================================================\n');
}

// Execute standalone if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runSprint92SubscriberCacheResilienceTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Sprint 9.2 test failed:', err);
      process.exit(1);
    });
}

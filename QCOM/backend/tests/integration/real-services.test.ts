import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const backendRoot = path.resolve(path.dirname(scriptPath), '../..');
const migrationRoot = path.join(backendRoot, 'migrations');
const databaseUrlValue = process.env.QCOM_IT_POSTGRES_URL;
const redisUrlValue = process.env.QCOM_IT_REDIS_URL;

function assertLoopbackUrl(value: string | undefined, variable: string): URL {
  if (!value) {
    throw new Error(`${variable} is required; real-service tests never fall back to pg-mem or in-memory Redis.`);
  }
  const parsed = new URL(value);
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(`${variable} must use a loopback host; refusing a remote or production service.`);
  }
  return parsed;
}

function assertDedicatedService(url: URL, variable: string, port: string, username?: string): void {
  if (url.port !== port) {
    throw new Error(`${variable} must use the dedicated integration port ${port}.`);
  }
  if (username && decodeURIComponent(url.username) !== username) {
    throw new Error(`${variable} must use the dedicated test account ${username}.`);
  }
  if (!url.password) {
    throw new Error(`${variable} must include the generated test-only service password.`);
  }
}

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
}

function withDatabase(url: URL, name: string): string {
  const copy = new URL(url.toString());
  copy.pathname = `/${name}`;
  return copy.toString();
}

async function waitForRealRedis(
  redisModule: typeof import('../../src/database/redis.js'),
  timeoutMs: number = 15000
): Promise<NonNullable<ReturnType<typeof redisModule.getRedisClient>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await redisModule.checkRedisHealth();
    const client = redisModule.getRedisClient();
    if (health.mode === 'redis' && health.alive && client) return client;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Redis did not become ready through the application Redis client.');
}

async function runRedisWorker(key: string, limit: number, attempts: number): Promise<number> {
  process.env.NODE_ENV = 'test';
  process.env.FORCE_REDIS = '1';
  process.env.REDIS_URL = redisUrlValue!;
  const redisModule = await import('../../src/database/redis.js');
  await waitForRealRedis(redisModule);
  const results = await Promise.all(
    Array.from({ length: attempts }, () => redisModule.slidingWindowRateLimit(key, limit, 60))
  );
  await redisModule.closeRedis();
  return results.filter((result) => result.allowed).length;
}

async function runRedisProcessPair(key: string, limit: number, attempts: number): Promise<number[]> {
  return Promise.all(Array.from({ length: 2 }, () => new Promise<number>((resolve, reject) => {
    const child = fork(scriptPath, [], {
      env: {
        ...process.env,
        QCOM_IT_REDIS_WORKER: '1',
        QCOM_IT_REDIS_KEY: key,
        QCOM_IT_REDIS_LIMIT: String(limit),
        QCOM_IT_REDIS_ATTEMPTS: String(attempts),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.once('message', (message: unknown) => {
      const result = message as { allowed?: number; error?: string };
      if (typeof result.allowed === 'number') resolve(result.allowed);
      else reject(new Error(result.error || 'Redis worker returned an invalid result.'));
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Redis worker exited with status ${code}.`));
    });
  })));
}

async function assertRedis7(client: NonNullable<ReturnType<typeof import('../../src/database/redis.js')['getRedisClient']>>): Promise<void> {
  const { assertExactRedisVersion, REQUIRED_REDIS_VERSION } = await import('../../src/config/redisVersion.js');
  const info = await client.info('server');
  const version = assertExactRedisVersion(info, REQUIRED_REDIS_VERSION);
  console.log(`Redis server version: ${version}`);
}

async function runRedisChecks(redisModule: typeof import('../../src/database/redis.js')): Promise<void> {
  const client = await waitForRealRedis(redisModule);
  await assertRedis7(client);

  const prefix = `qcom-it:${randomUUID()}`;
  const boundaryKey = `${prefix}:boundary`;
  const sharedKey = `${prefix}:multiprocess`;
  const createdRedisKeys = new Set([`ratelimit:${boundaryKey}`, `ratelimit:${sharedKey}`]);
  try {
    const boundary = await Promise.all(
      Array.from({ length: 4 }, () => redisModule.slidingWindowRateLimit(boundaryKey, 3, 60))
    );
    assert.equal(boundary.filter((result) => result.allowed).length, 3, 'Limit boundary must admit exactly three requests.');
    const rejected = boundary.find((result) => !result.allowed);
    assert.ok(rejected && rejected.resetSec >= 1 && rejected.resetSec <= 60, 'Rejected requests must have a bounded Retry-After value.');
    const count = await client.zcard(`ratelimit:${boundaryKey}`);
    assert.equal(count, 3, 'Atomic limiter must insert only admitted requests.');

    const workerAdmissions = await runRedisProcessPair(sharedKey, 20, 35);
    assert.equal(workerAdmissions.reduce((sum, admitted) => sum + admitted, 0), 20,
      'Independent backend processes must share the same Redis admission limit.');
    assert.equal(await client.zcard(`ratelimit:${sharedKey}`), 20,
      'Concurrent Redis admissions must not exceed the distributed limit.');

    const express = (await import('express')).default;
    const { env } = await import('../../src/config/env.js');
    const { createSlidingWindowRateLimiter } = await import('../../src/middleware/rateLimiter.js');
    const app = express();
    const previousTrustedProxyCidrs = env.TRUST_PROXY_CIDRS;
    env.TRUST_PROXY_CIDRS = '';
    app.set('trust proxy', []);
    const sourceIpScope = `${prefix}:source-ip`;
    app.get('/source-ip', createSlidingWindowRateLimiter({
      limit: 2,
      windowSec: 60,
      scope: sourceIpScope,
      keyGenerator: (request) => {
        const clientIp = request.ip || request.socket.remoteAddress || '127.0.0.1';
        createdRedisKeys.add(`ratelimit:${sourceIpScope}:${clientIp}`);
        return clientIp;
      },
    }), (_request, response) => response.status(204).end());
    const identityScope = `${prefix}:identity`;
    app.get('/identity', createSlidingWindowRateLimiter({
      limit: 2,
      windowSec: 60,
      scope: identityScope,
      keyGenerator: (request) => {
        const identity = `identity:${request.header('x-test-actor')}`;
        const ip = `ip:${request.ip || request.socket.remoteAddress || '127.0.0.1'}`;
        createdRedisKeys.add(`ratelimit:${identityScope}:${identity}`);
        createdRedisKeys.add(`ratelimit:${identityScope}:${ip}`);
        return [{ key: identity }, { key: ip, limit: 10 }];
      },
    }), (_request, response) => response.status(204).end());

    const commandFailureClosedScope = `${prefix}:failure-closed`;
    const commandFailureOpenScope = `${prefix}:failure-open`;
    const commandFailureKeyClosed = `${commandFailureClosedScope}:forced`;
    const commandFailureKeyOpen = `${commandFailureOpenScope}:forced`;
    createdRedisKeys.add(`ratelimit:${commandFailureKeyClosed}`);
    createdRedisKeys.add(`ratelimit:${commandFailureKeyOpen}`);
    await client.set(`ratelimit:${commandFailureKeyClosed}`, 'wrong-type');
    await client.set(`ratelimit:${commandFailureKeyOpen}`, 'wrong-type');
    app.get('/failure-closed', createSlidingWindowRateLimiter({
      limit: 1,
      windowSec: 60,
      scope: commandFailureClosedScope,
      keyGenerator: () => 'forced',
      failureMode: 'closed',
    }), (_request, response) => response.status(204).end());
    app.get('/failure-open', createSlidingWindowRateLimiter({
      limit: 1,
      windowSec: 60,
      scope: commandFailureOpenScope,
      keyGenerator: () => 'forced',
      failureMode: 'open',
    }), (_request, response) => response.status(204).end());

    const server = await new Promise<import('node:http').Server>((resolve) => {
      const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const sourceResponses = await Promise.all([
        fetch(`${baseUrl}/source-ip`, { headers: { 'X-Forwarded-For': '198.51.100.10' } }),
        fetch(`${baseUrl}/source-ip`, { headers: { 'X-Forwarded-For': '203.0.113.20' } }),
        fetch(`${baseUrl}/source-ip`, { headers: { 'X-Forwarded-For': '192.0.2.30' } }),
      ]);
      assert.deepEqual(sourceResponses.map((response) => response.status).sort(), [204, 204, 429],
        'Untrusted forwarded headers must not create distinct client identities.');
      const rejectedResponse = sourceResponses.find((response) => response.status === 429)!;
      const retryAfter = Number(rejectedResponse.headers.get('retry-after'));
      assert.ok(retryAfter >= 1 && retryAfter <= 60, '429 response must return a bounded Retry-After header.');

      const identityResponses = await Promise.all([
        fetch(`${baseUrl}/identity`, { headers: { 'X-Test-Actor': 'integration-actor', 'X-Forwarded-For': '198.51.100.10' } }),
        fetch(`${baseUrl}/identity`, { headers: { 'X-Test-Actor': 'integration-actor', 'X-Forwarded-For': '203.0.113.20' } }),
        fetch(`${baseUrl}/identity`, { headers: { 'X-Test-Actor': 'integration-actor', 'X-Forwarded-For': '192.0.2.30' } }),
      ]);
      assert.deepEqual(identityResponses.map((response) => response.status).sort(), [204, 204, 429],
        'Identity-scoped admission must remain shared across source-IP header changes.');

      const { NODE_ENV } = env;
      env.NODE_ENV = 'production';
      try {
        const closedResponse = await fetch(`${baseUrl}/failure-closed`);
        assert.equal(closedResponse.status, 503, 'Sensitive request must fail closed on Redis command error.');
        assert.equal(closedResponse.headers.get('retry-after'), '3');
        const openResponse = await fetch(`${baseUrl}/failure-open`);
        assert.equal(openResponse.status, 204, 'General request policy must explicitly fail open.');
        assert.equal(openResponse.headers.get('x-ratelimit-status'), 'unavailable');
      } finally {
        env.NODE_ENV = NODE_ENV;
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      env.TRUST_PROXY_CIDRS = previousTrustedProxyCidrs;
    }

    console.log('Redis 7 atomic boundary, independent processes, source-IP trust, Retry-After, and fail-open/fail-closed behavior passed.');
  } finally {
    await client.del(...createdRedisKeys);
  }
}

async function claimInTransaction(
  pool: import('pg').Pool,
  service?: import('../../src/modules/outbox/outboxService.js').OutboxService
): Promise<import('../../src/modules/outbox/outboxTypes.js').OutboxEvent[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { outboxService } = service
      ? { outboxService: service }
      : await import('../../src/modules/outbox/outboxService.js');
    const claimed = await outboxService.claimPendingEvents(1, client);
    await client.query('COMMIT');
    return claimed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function runPostgresChecks(): Promise<void> {
  const adminUrl = assertLoopbackUrl(databaseUrlValue, 'QCOM_IT_POSTGRES_URL');
  assertDedicatedService(adminUrl, 'QCOM_IT_POSTGRES_URL', '55432', 'qcom_it_admin');
  if (databaseName(adminUrl) !== 'postgres') {
    throw new Error('QCOM_IT_POSTGRES_URL must target the postgres maintenance database; refusing to create databases elsewhere.');
  }

  const pg = await import('pg');
  const adminPool = new pg.default.Pool({ connectionString: adminUrl.toString(), max: 2 });
  const createdDatabases: string[] = [];
  let migrationDirectory: string | undefined;
  try {
    const versionResult = await adminPool.query<{ server_version_num: string }>(
      `SELECT current_setting('server_version_num') AS server_version_num`
    );
    const versionNumber = Number(versionResult.rows[0]?.server_version_num);
    assert.ok(versionNumber >= 160000 && versionNumber < 170000,
      `PostgreSQL 16 required; server reported version number ${versionNumber}.`);
    console.log(`PostgreSQL server version: ${(versionNumber / 10000).toFixed(2)}`);

    const freshName = `qcom_it_${randomUUID().replace(/-/g, '')}`;
    const upgradeName = `qcom_it_${randomUUID().replace(/-/g, '')}`;
    for (const name of [freshName, upgradeName]) {
      assert.match(name, /^qcom_it_[a-f0-9]{32}$/);
      await adminPool.query(`CREATE DATABASE "${name}"`);
      createdDatabases.push(name);
    }

    const { Pool } = pg.default;
    const freshPool = new Pool({ connectionString: withDatabase(adminUrl, freshName), max: 12 });
    const upgradePool = new Pool({ connectionString: withDatabase(adminUrl, upgradeName), max: 4 });
    const { runMigrations, getMigrationFiles } = await import('../../src/database/migrator.js');
    const { setPool } = await import('../../src/database/connection.js');
    setPool(freshPool);
    try {
      const migrationFiles = getMigrationFiles(migrationRoot);
      const applied = await runMigrations({ poolOverride: freshPool });
      assert.equal(
        applied.length,
        migrationFiles.length,
        `Fresh database must apply all ${migrationFiles.length} migrations (001–026+).`
      );
      assert.ok(applied.length >= 26, `Expected at least 26 migrations, got ${applied.length}.`);
      assert.ok(applied.some((name) => name.startsWith('026_')), 'Fresh database must apply migration 026.');
      assert.deepEqual(await runMigrations({ poolOverride: freshPool }), [], 'A migration rerun must apply no changes.');

      const previousFiles = migrationFiles.filter((migration) => Number(migration.version) < 25);
      assert.equal(previousFiles.length, 24, 'Expected migrations 001 through 024 before migration 025.');
      migrationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'qcom-it-migrations-'));
      for (const migration of previousFiles) {
        await fs.copyFile(migration.fullPath, path.join(migrationDirectory, migration.name));
      }

      setPool(upgradePool);
      await runMigrations({ poolOverride: upgradePool, migrationsDir: migrationDirectory });
      const aggregateId = randomUUID();
      const legacyEvent = await upgradePool.query<{ id: string }>(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, status)
         VALUES ('QCOM_IT_UPGRADE', 'TEST', $1, '{"upgrade":true}', 'PENDING')
         RETURNING id`,
        [aggregateId]
      );
      assert.equal(legacyEvent.rowCount, 1);
      const upgradeApplied = await runMigrations({ poolOverride: upgradePool });
      assert.ok(upgradeApplied.some((name) => name.startsWith('025_')), 'Upgrade must apply migration 025.');
      assert.ok(upgradeApplied.some((name) => name.startsWith('026_')), 'Upgrade must apply migration 026.');
      assert.ok(upgradeApplied.some((name) => name.startsWith('027_')), 'Upgrade must apply migration 027.');
      assert.ok(upgradeApplied.some((name) => name.startsWith('028_')), 'Upgrade must apply migration 028.');
      const upgradedTripIndexes = await upgradePool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname IN (
             'uq_delivery_trips_forward_order',
             'uq_delivery_trips_reverse_return',
             'uq_delivery_trips_active_reverse_order',
             'idx_riders_dispatch_candidates'
           )`
      );
      assert.equal(upgradedTripIndexes.rowCount, 4, 'Migration 028 partial unique and GPS indexes must exist on upgraded DB.');
      const legacyOrderUnique = await upgradePool.query(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'delivery_trips'::regclass AND contype = 'u'
           AND pg_get_constraintdef(oid) = 'UNIQUE (order_id)'`
      );
      assert.equal(legacyOrderUnique.rowCount, 0, 'Unconditional delivery_trips(order_id) UNIQUE constraint must be dropped by migration 028.');
      const preserved = await upgradePool.query(
        `SELECT status, lease_token, lease_expires_at FROM outbox_events WHERE id = $1`,
        [legacyEvent.rows[0].id]
      );
      assert.equal(preserved.rows[0].status, 'PENDING', 'Preexisting pending event must remain pending.');
      assert.equal(preserved.rows[0].lease_token, null);
      assert.equal(preserved.rows[0].lease_expires_at, null);

      const index = await upgradePool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_outbox_pending_lease'`
      );
      assert.equal(index.rowCount, 1, 'Migration 025 partial index must exist in PostgreSQL.');
      const oldIndex = await upgradePool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_outbox_pending'`
      );
      assert.equal(oldIndex.rowCount, 0, 'Previous pending index must be replaced by the lease-aware index.');
      const statusConstraint = await upgradePool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'outbox_events'::regclass AND contype = 'c'`
      );
      assert.ok(statusConstraint.rows.some(({ definition }) => definition.includes('DEAD_LETTER')),
        'Existing outbox status constraint must remain intact after migration 025.');
      const upgradedColumns = await upgradePool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'outbox_events'
           AND column_name IN ('lease_token', 'lease_expires_at')`
      );
      assert.equal(upgradedColumns.rowCount, 2, 'Migration 025 lease columns must exist.');

      setPool(upgradePool);
      const { outboxService } = await import('../../src/modules/outbox/outboxService.js');
      const upgradedClaim = (await claimInTransaction(upgradePool)).find((claim) => claim.id === legacyEvent.rows[0].id);
      assert.ok(upgradedClaim?.leaseToken, 'A pending pre-migration event must remain claimable.');
      await outboxService.markPublished(legacyEvent.rows[0].id, upgradedClaim.leaseToken!);

      setPool(freshPool);
      const { OutboxService } = await import('../../src/modules/outbox/outboxService.js');
      const { outboxService: freshOutboxService } = await import('../../src/modules/outbox/outboxService.js');
      const stage = async (eventType: string) => {
        const client = await freshPool.connect();
        try {
          await client.query('BEGIN');
          const staged = await freshOutboxService.stageEvent(client, {
            eventType,
            aggregateType: 'TEST',
            aggregateId: randomUUID(),
            payload: { isolated: true },
          });
          await client.query('COMMIT');
          return staged;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };
      const event = await stage('QCOM_IT_CONCURRENCY');
      const firstClaims = await Promise.all([
        claimInTransaction(freshPool, freshOutboxService),
        claimInTransaction(freshPool, freshOutboxService),
      ]);
      const claimsForEvent = firstClaims.flat().filter((claim) => claim.id === event.id);
      assert.equal(claimsForEvent.length, 1, 'Concurrent separate PostgreSQL connections must yield one active owner.');
      const staleToken = claimsForEvent[0].leaseToken;
      assert.ok(staleToken);

      await freshPool.query(
        `UPDATE outbox_events SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [event.id]
      );
      const restartedOutboxService = new OutboxService();
      const restartedClaim = (await claimInTransaction(freshPool, restartedOutboxService)).find((claim) => claim.id === event.id);
      assert.ok(restartedClaim?.leaseToken && restartedClaim.leaseToken !== staleToken,
        'Expired lease recovery must assign a new fencing token.');
      await assert.rejects(() => restartedOutboxService.markPublished(event.id, staleToken!), /OUTBOX_LEASE_LOST/);
      await assert.rejects(() => restartedOutboxService.markFailed(event.id, 'stale owner', undefined, staleToken!), /OUTBOX_LEASE_LOST/);
      await restartedOutboxService.markPublished(event.id, restartedClaim!.leaseToken!);

      const rollbackEvent = await stage('QCOM_IT_ROLLBACK');
      const rollbackClient = await freshPool.connect();
      await rollbackClient.query('BEGIN');
      const rolledBackClaim = await freshOutboxService.claimPendingEvents(1, rollbackClient);
      await rollbackClient.query('ROLLBACK');
      rollbackClient.release();
      assert.ok(rolledBackClaim.some((claim) => claim.id === rollbackEvent.id));
      const rollbackState = await freshPool.query(
        `SELECT lease_token FROM outbox_events WHERE id = $1`,
        [rollbackEvent.id]
      );
      assert.equal(rollbackState.rows[0].lease_token, null, 'Rolled-back claim must not persist partial lease state.');
      const afterRollbackClaim = (await claimInTransaction(freshPool, freshOutboxService))
        .find((claim) => claim.id === rollbackEvent.id);
      assert.ok(afterRollbackClaim?.leaseToken, 'A rolled-back claim must remain available to another worker.');
      await freshOutboxService.markPublished(rollbackEvent.id, afterRollbackClaim.leaseToken!);

      const longHandlerEvent = await stage('QCOM_IT_LONG_HANDLER');
      let handlerRuns = 0;
      let notifyFirstHandlerStarted!: () => void;
      const firstHandlerStarted = new Promise<void>((resolve) => {
        notifyFirstHandlerStarted = resolve;
      });
      let releaseFirstHandler!: () => void;
      const firstHandlerGate = new Promise<void>((resolve) => {
        releaseFirstHandler = resolve;
      });
      const slowWorker = new OutboxService();
      slowWorker.registerConsumer('QCOM_IT_LONG_HANDLER', async (outboxEvent) => {
        handlerRuns++;
        if (outboxEvent.id === longHandlerEvent.id) {
          notifyFirstHandlerStarted();
          await firstHandlerGate;
        }
      });
      const slowDelivery = slowWorker.processOutboxBatch(1);
      await firstHandlerStarted;
      await freshPool.query(
        `UPDATE outbox_events SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [longHandlerEvent.id]
      );
      const restartedWorker = new OutboxService();
      restartedWorker.registerConsumer('QCOM_IT_LONG_HANDLER', async () => {
        handlerRuns++;
      });
      const restartedDelivery = await restartedWorker.processOutboxBatch(1);
      assert.equal(restartedDelivery.succeeded, 1, 'A restarted worker must complete after the prior lease expires.');
      releaseFirstHandler();
      await assert.rejects(() => slowDelivery, /OUTBOX_LEASE_LOST/,
        'The original over-lease handler must not overwrite the restarted worker result.');
      assert.equal(handlerRuns, 2, 'An over-lease handler may be delivered twice; consumers must be idempotent.');

      await runSprint15_7PostgresChecks(freshPool);

      console.log('PostgreSQL 16 fresh/upgrade migrations, Sprint 15.7 integrity/concurrency/pg_locks checks, outbox claims, fencing, and rollback checks passed.');
    } finally {
      setPool(null);
      await Promise.all([freshPool.end(), upgradePool.end()]);
    }
  } finally {
    if (migrationDirectory) {
      await fs.rm(migrationDirectory, { recursive: true, force: true });
    }
    for (const name of createdDatabases) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name]
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${name}"`);
    }
    await adminPool.end();
  }
}

async function runSprint15_7PostgresChecks(freshPool: import('pg').Pool): Promise<void> {
  const crypto = await import('node:crypto');
  const { runSeeds } = await import('../../seeds/seedData.js');
  const { deliveryCompletionService } = await import('../../src/modules/delivery/deliveryCompletionService.js');
  const { settlementAllocationService } = await import('../../src/modules/settlements/settlementAllocationService.js');
  const { dispatchService } = await import('../../src/modules/dispatch/dispatchService.js');
  const { candidateGenerator } = await import('../../src/modules/dispatch/candidateGenerator.js');
  const { cancellationService } = await import('../../src/modules/orders/cancellationService.js');
  const { refundService } = await import('../../src/modules/payments/refundService.js');
  const { returnService } = await import('../../src/modules/orders/returnService.js');
  const { ledgerService } = await import('../../src/modules/ledger/ledgerService.js');

  await runSeeds(freshPool);

  const merchRow = (
    await freshPool.query(`SELECT id, latitude, longitude FROM merchants WHERE merchant_code = 'MERCH-BLR-01' LIMIT 1`)
  ).rows[0];
  const merchantId = merchRow.id as string;
  const storeLat = Number(merchRow.latitude);
  const storeLng = Number(merchRow.longitude);

  const prodRow = (
    await freshPool.query(
      `SELECT p.id, p.name, si.selling_price
       FROM products p JOIN store_inventory si ON si.product_id = p.id
       WHERE si.merchant_id = $1 LIMIT 1`,
      [merchantId]
    )
  ).rows[0];
  const productId = prodRow.id as string;
  const productName = prodRow.name as string;
  const unitPrice = Number(prodRow.selling_price);

  const userRow = (await freshPool.query(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`)).rows[0];
  const userId = userRow.id as string;
  const riderRows = (
    await freshPool.query(`SELECT id FROM riders ORDER BY created_at ASC LIMIT 2`)
  ).rows;
  const rider1Id = riderRows[0].id as string;
  const rider2Id = riderRows[1].id as string;

  await freshPool.query(
    `UPDATE store_inventory SET stock_count = 500 WHERE merchant_id = $1 AND product_id = $2`,
    [merchantId, productId]
  );

  async function seedOrderAndForwardTrip(opts: {
    paymentMethod: 'Pay on Delivery' | 'Instant UPI';
    paymentStatus: string;
    status: string;
    tripStatus: string;
    riderId: string | null;
    totalAmount: number;
    postPaymentGl?: boolean;
  }) {
    const orderId = crypto.randomUUID();
    const tripId = crypto.randomUUID();
    const orderItemId = crypto.randomUUID();
    const otp = '642819';
    const total = +opts.totalAmount.toFixed(2);
    const snapshot = {
      sellerGoodsBreakdown: {
        taxableAmount: +(total / 1.18).toFixed(2),
        totalGst: +(total - total / 1.18).toFixed(2),
        totalSellerPayable: total,
      },
      qcomFeesBreakdown: {
        deliveryTaxable: 0,
        deliveryGst: 0,
        handlingTaxable: 0,
        handlingGst: 0,
        totalGst: 0,
      },
    };

    await freshPool.query(
      `INSERT INTO orders (
         id, order_number, user_id, merchant_id, status,
         items_subtotal, delivery_fee, handling_fee, urgency_fee, discount_amount,
         taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount,
         payment_method, payment_status, delivery_otp, handover_token,
         jobsite_address, pricing_snapshot, placed_at, estimated_delivery_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0, $7, 0, 0, 0, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW() + INTERVAL '30 minutes')`,
      [
        orderId,
        `ORD-IT-${Date.now().toString().slice(-4)}-${crypto.randomBytes(2).toString('hex')}`,
        userId,
        merchantId,
        opts.status,
        total,
        +(total / 1.18).toFixed(2),
        total,
        opts.paymentMethod,
        opts.paymentStatus,
        otp,
        `HND-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
        JSON.stringify({ address: 'PG IT Site', latitude: storeLat + 0.02, longitude: storeLng + 0.02 }),
        JSON.stringify(snapshot),
      ]
    );

    await freshPool.query(
      `INSERT INTO order_items (
         id, order_id, product_id, product_name, quantity, unit_price, hsn_code, gst_rate_percent, taxable_amount, cgst_amount, sgst_amount, total_price
       )
       VALUES ($1, $2, $3, $4, 1, $5, '6810', 18.00, $6, 0, 0, $5)`,
      [orderItemId, orderId, productId, productName, total, +(total / 1.18).toFixed(2)]
    );

    if (opts.postPaymentGl) {
      await ledgerService.recordOrderPayment({
        orderId,
        merchantId,
        grossAmount: total,
        taxableAmount: +(total / 1.18).toFixed(2),
        cgstAmount: 0,
        sgstAmount: 0,
        deliveryFee: 0,
        handlingFee: 0,
      });
    }

    const nowTs = new Date();
    await freshPool.query(
      `INSERT INTO delivery_trips (
         id, order_id, trip_type, rider_id, status,
         base_fare, distance_fare, surge_fare, total_rider_payout,
         accepted_at, picked_up_at
       )
       VALUES ($1, $2, 'FORWARD', $3, $4, 50, 15, 0, 65, $5, $6)`,
      [
        tripId,
        orderId,
        opts.riderId,
        opts.tripStatus,
        opts.riderId ? nowTs : null,
        opts.tripStatus === 'PICKED_UP' ? nowTs : null,
      ]
    );

    return { orderId, tripId, orderItemId, otp, total };
  }

  // 1. Real PG partial unique index enforcement (23505) on delivery_trips
  const revBase = await seedOrderAndForwardTrip({
    paymentMethod: 'Instant UPI',
    paymentStatus: 'PAID',
    status: 'delivered',
    tripStatus: 'DELIVERED',
    riderId: rider1Id,
    totalAmount: unitPrice,
    postPaymentGl: true,
  });
  await settlementAllocationService.allocateFulfilledOrder(revBase.orderId);

  await assert.rejects(
    () =>
      freshPool.query(
        `INSERT INTO delivery_trips (order_id, trip_type, status, base_fare, distance_fare, total_rider_payout)
         VALUES ($1, 'FORWARD', 'BROADCASTING', 45, 0, 45)`,
        [revBase.orderId]
      ),
    (err: any) => err?.code === '23505'
  );

  const ret1 = await returnService.requestReturn({
    orderId: revBase.orderId,
    userId,
    items: [{ orderItemId: revBase.orderItemId, quantity: 1 }],
    reasonCode: 'DEFECTIVE',
  });
  const revTrip1 = await dispatchService.createReversePickupTrip({
    returnId: ret1.returnRequest.id,
    orderId: revBase.orderId,
    merchantId,
  });

  await assert.rejects(
    () =>
      freshPool.query(
        `INSERT INTO delivery_trips (order_id, trip_type, return_id, status, base_fare, distance_fare, total_rider_payout)
         VALUES ($1, 'REVERSE_PICKUP', $2, 'BROADCASTING', 45, 0, 45)`,
        [revBase.orderId, ret1.returnRequest.id]
      ),
    (err: any) => err?.code === '23505'
  );

  const ret2Id = crypto.randomUUID();
  await freshPool.query(
    `INSERT INTO order_returns (id, return_number, order_id, user_id, merchant_id, status, reason_code)
     VALUES ($1, $2, $3, $4, $5, 'APPROVED', 'DAMAGED')`,
    [ret2Id, `RET-IT-${Date.now()}`, revBase.orderId, userId, merchantId]
  );
  await assert.rejects(
    () =>
      freshPool.query(
        `INSERT INTO delivery_trips (order_id, trip_type, return_id, status, base_fare, distance_fare, total_rider_payout)
         VALUES ($1, 'REVERSE_PICKUP', $2, 'BROADCASTING', 45, 0, 45)`,
        [revBase.orderId, ret2Id]
      ),
    (err: any) => err?.code === '23505'
  );

  await dispatchService.cancelReversePickupTrip({ returnId: ret1.returnRequest.id });
  const revTrip2 = await dispatchService.createReversePickupTrip({
    returnId: ret2Id,
    orderId: revBase.orderId,
    merchantId,
  });
  assert.notEqual(revTrip2, revTrip1, 'New reverse pickup trip must succeed after prior reverse trip is CANCELLED');

  // 2. Concurrent completeDeliveryWithOtp race on real PostgreSQL 16 + COD tamper guard
  const concCod = await seedOrderAndForwardTrip({
    paymentMethod: 'Pay on Delivery',
    paymentStatus: 'PENDING',
    status: 'out_for_delivery',
    tripStatus: 'PICKED_UP',
    riderId: rider1Id,
    totalAmount: 480,
  });
  const floatPre = Number(
    (await freshPool.query(`SELECT floating_cash_balance FROM riders WHERE id = $1`, [rider1Id])).rows[0]
      .floating_cash_balance
  );

  const raceResults = await Promise.allSettled([
    deliveryCompletionService.completeDeliveryWithOtp({
      taskId: concCod.tripId,
      otp: concCod.otp,
      cashCollected: 12,
      actor: { riderId: rider1Id, isDispatchAdmin: false, actorUserId: userId },
    }),
    deliveryCompletionService.completeDeliveryWithOtp({
      taskId: concCod.tripId,
      otp: concCod.otp,
      cashCollected: 12,
      actor: { riderId: rider1Id, isDispatchAdmin: false, actorUserId: userId },
    }),
  ]);
  const fulfilledRace = raceResults.filter((r) => r.status === 'fulfilled');
  const rejectedRace = raceResults.filter((r) => r.status === 'rejected');
  assert.equal(fulfilledRace.length, 1, 'Exactly one concurrent completion must succeed on real PG 16.');
  assert.equal(rejectedRace.length, 1, 'Second concurrent completion must be rejected cleanly.');
  assert.equal((fulfilledRace[0] as PromiseFulfilledResult<any>).value.codCollectedAmount, 480);

  const floatPost = Number(
    (await freshPool.query(`SELECT floating_cash_balance FROM riders WHERE id = $1`, [rider1Id])).rows[0]
      .floating_cash_balance
  );
  assert.equal(floatPost, floatPre + 480, 'Rider floating_cash_balance must increment exactly once.');
  const allocCnt = Number(
    (await freshPool.query(`SELECT COUNT(*) AS cnt FROM order_settlement_allocations WHERE order_id = $1`, [concCod.orderId]))
      .rows[0].cnt
  );
  assert.equal(allocCnt, 1, 'Strictly one settlement allocation row per delivered order.');

  // 3. Mid-TX failure injection on real PG 16 -> full atomic rollback -> retry succeeds
  const failOrd = await seedOrderAndForwardTrip({
    paymentMethod: 'Pay on Delivery',
    paymentStatus: 'PENDING',
    status: 'out_for_delivery',
    tripStatus: 'PICKED_UP',
    riderId: rider2Id,
    totalAmount: 310,
  });
  const r2FloatPre = Number(
    (await freshPool.query(`SELECT floating_cash_balance FROM riders WHERE id = $1`, [rider2Id])).rows[0]
      .floating_cash_balance
  );
  const origAlloc = settlementAllocationService.allocateFulfilledOrder.bind(settlementAllocationService);
  (settlementAllocationService as any).allocateFulfilledOrder = async () => {
    throw new Error('PG_INJECTED_SETTLEMENT_ERROR');
  };
  try {
    await assert.rejects(
      () =>
        deliveryCompletionService.completeDeliveryWithOtp({
          taskId: failOrd.tripId,
          otp: failOrd.otp,
          actor: { riderId: rider2Id, isDispatchAdmin: false, actorUserId: userId },
        }),
      /PG_INJECTED_SETTLEMENT_ERROR/
    );
  } finally {
    (settlementAllocationService as any).allocateFulfilledOrder = origAlloc;
  }
  const rolledBackOrd = (
    await freshPool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [failOrd.orderId])
  ).rows[0];
  assert.equal(rolledBackOrd.status, 'out_for_delivery');
  assert.equal(rolledBackOrd.payment_status, 'PENDING');
  const r2FloatMid = Number(
    (await freshPool.query(`SELECT floating_cash_balance FROM riders WHERE id = $1`, [rider2Id])).rows[0]
      .floating_cash_balance
  );
  assert.equal(r2FloatMid, r2FloatPre);

  const retryComplete = await deliveryCompletionService.completeDeliveryWithOtp({
    taskId: failOrd.tripId,
    otp: failOrd.otp,
    actor: { riderId: rider2Id, isDispatchAdmin: false, actorUserId: userId },
  });
  assert.equal(retryComplete.codCollectedAmount, 310);

  // 4. Lock-free external refund verified via pg_locks on real PostgreSQL 16
  const cancelOrd = await seedOrderAndForwardTrip({
    paymentMethod: 'Instant UPI',
    paymentStatus: 'PAID',
    status: 'placed',
    tripStatus: 'BROADCASTING',
    riderId: null,
    totalAmount: 275,
    postPaymentGl: true,
  });
  const origProvider = refundService.getProvider();
  let notifyGatewayEntered!: () => void;
  const gatewayEntered = new Promise<void>((resolve) => {
    notifyGatewayEntered = resolve;
  });
  let releaseGateway!: () => void;
  const gatewayGate = new Promise<void>((resolve) => {
    releaseGateway = resolve;
  });

  const barrierProvider = Object.assign(Object.create(Object.getPrototypeOf(origProvider)), origProvider, {
    async createRefund(req: { paymentId: string; amount: number; currency: string }) {
      notifyGatewayEntered();
      await gatewayGate;
      return {
        providerRefundId: `rfnd_pg_it_${Date.now()}`,
        paymentId: req.paymentId,
        amount: req.amount,
        currency: req.currency || 'INR',
        status: 'PROCESSED' as const,
        timestamp: new Date().toISOString(),
      };
    },
  });
  refundService.setProvider(barrierProvider);

  const pgIdemKey = `pg_cancel_${Date.now()}`;
  const cancelPromise = cancellationService.cancelByCustomer({
    orderId: cancelOrd.orderId,
    userId,
    reason: 'PG lock-free check',
    idempotencyKey: pgIdemKey,
  });
  try {
    await gatewayEntered;
    const midOrderRow = (
      await freshPool.query(`SELECT status FROM orders WHERE id = $1`, [cancelOrd.orderId])
    ).rows[0];
    assert.equal(midOrderRow.status, 'cancelled', 'Phase 1 TX must commit order cancellation before external refund HTTP call.');

    const heldWriteLocks = await freshPool.query<{ relname: string; mode: string }>(
      `SELECT c.relname, l.mode
       FROM pg_locks l
       JOIN pg_class c ON c.oid = l.relation
       JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE a.datname = current_database()
         AND l.pid <> pg_backend_pid()
         AND l.granted = TRUE
         AND c.relname IN ('orders', 'delivery_trips', 'store_inventory', 'order_returns')
         AND l.mode IN ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')`
    );
    assert.equal(
      heldWriteLocks.rowCount,
      0,
      `External gateway call must hold ZERO DB table/row write locks; found: ${JSON.stringify(heldWriteLocks.rows)}`
    );
  } finally {
    releaseGateway();
  }
  const cancelDone = await cancelPromise;
  refundService.setProvider(origProvider);
  assert.equal(cancelDone.order.payment_status, 'REFUNDED');

  await assert.rejects(
    () =>
      cancellationService.cancelByAdmin({
        orderId: cancelOrd.orderId,
        adminUserId: crypto.randomUUID(),
        reason: 'Cross actor key reuse',
        idempotencyKey: pgIdemKey,
      }),
    /IDEMPOTENCY_KEY_ACTOR_MISMATCH/
  );

  // 5. Real PG GPS filtering (NULL, (0,0), out-of-range, stale >10m)
  await freshPool.query(`UPDATE riders SET status = 'OFFLINE'`);
  const validGpsRiderId = crypto.randomUUID();
  await freshPool.query(
    `INSERT INTO riders (id, rider_code, name, phone, status, vehicle_type, payload_capacity_kg, latitude, longitude, location_updated_at)
     VALUES
       ($1, 'PG-NULL',  'PG Null',  '+91-9000100001', 'AVAILABLE', 'ev_scooter', 25, NULL, NULL, NOW()),
       ($2, 'PG-ZERO',  'PG Zero',  '+91-9000100002', 'AVAILABLE', 'ev_scooter', 25, 0, 0, NOW()),
       ($3, 'PG-BAD',   'PG Bad',   '+91-9000100003', 'AVAILABLE', 'ev_scooter', 25, 92.0, 185.0, NOW()),
       ($4, 'PG-STALE', 'PG Stale', '+91-9000100004', 'AVAILABLE', 'ev_scooter', 25, $6, $7, NOW() - INTERVAL '20 minutes'),
       ($5, 'PG-VALID', 'PG Valid', '+91-9000100005', 'AVAILABLE', 'ev_scooter', 25, $6, $7, NOW())`,
    [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      validGpsRiderId,
      storeLat + 0.008,
      storeLng + 0.008,
    ]
  );

  const gpsCandidates = await candidateGenerator.generateCandidates({
    orderId: revBase.orderId,
    merchantId,
    storeLocation: { latitude: storeLat, longitude: storeLng },
    customerLocation: { latitude: storeLat + 0.02, longitude: storeLng + 0.02 },
    itemsSubtotal: 500,
    customerDeliveryFee: 20,
    handlingFee: 5,
  });
  assert.deepEqual(gpsCandidates.map((c) => c.riderId), [validGpsRiderId]);

  console.log('PostgreSQL 16 Sprint 15.7 checks (partial unique 23505, multi-conn OTP race, mid-TX rollback, pg_locks lock-free refund, GPS filtering) passed.');
}

async function runSuite(): Promise<void> {
  const adminUrl = assertLoopbackUrl(databaseUrlValue, 'QCOM_IT_POSTGRES_URL');
  assertDedicatedService(adminUrl, 'QCOM_IT_POSTGRES_URL', '55432', 'qcom_it_admin');
  if (databaseName(adminUrl) !== 'postgres') {
    throw new Error('QCOM_IT_POSTGRES_URL must target the postgres maintenance database.');
  }
  const redisUrl = assertLoopbackUrl(redisUrlValue, 'QCOM_IT_REDIS_URL');
  assertDedicatedService(redisUrl, 'QCOM_IT_REDIS_URL', '56379');
  process.env.NODE_ENV = 'test';
  process.env.FORCE_REDIS = '1';
  process.env.DATABASE_URL = adminUrl.toString();
  process.env.REDIS_URL = redisUrl.toString();

  console.log('Running real-service integration checks. No simulated-service fallback is permitted.');
  const redisModule = await import('../../src/database/redis.js');
  try {
    const redisClient = await waitForRealRedis(redisModule);
    await assertRedis7(redisClient);
    await runPostgresChecks();
    await runRedisChecks(redisModule);
  } finally {
    await redisModule.closeRedis();
  }
  console.log('Real PostgreSQL 16 and Redis 7 integration checks passed.');
}

async function main(): Promise<void> {
  if (process.env.QCOM_IT_REDIS_WORKER) {
    try {
      const admitted = await runRedisWorker(
        process.env.QCOM_IT_REDIS_KEY!,
        Number(process.env.QCOM_IT_REDIS_LIMIT),
        Number(process.env.QCOM_IT_REDIS_ATTEMPTS)
      );
      process.send?.({ allowed: admitted }, () => process.disconnect());
    } catch (error) {
      process.send?.({ error: error instanceof Error ? error.message : String(error) }, () => process.disconnect());
      process.exitCode = 1;
    }
    return;
  }
  await runSuite();
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error('Real-service integration suite failed:', error);
    process.exitCode = 1;
  });
}

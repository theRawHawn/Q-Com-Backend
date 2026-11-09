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
  const info = await client.info('server');
  const version = info.match(/^redis_version:([^\r\n]+)/m)?.[1];
  assert.ok(version?.startsWith('7.'), `Redis 7 required; server reported ${version || 'unknown'}.`);
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
    const freshPool = new Pool({ connectionString: withDatabase(adminUrl, freshName), max: 6 });
    const upgradePool = new Pool({ connectionString: withDatabase(adminUrl, upgradeName), max: 4 });
    const { runMigrations, getMigrationFiles } = await import('../../src/database/migrator.js');
    const { setPool } = await import('../../src/database/connection.js');
    setPool(freshPool);
    try {
      const applied = await runMigrations({ poolOverride: freshPool });
      assert.equal(applied.length, 25, 'Fresh database must apply all 25 migrations.');
      assert.deepEqual(await runMigrations({ poolOverride: freshPool }), [], 'A migration rerun must apply no changes.');

      const migrationFiles = getMigrationFiles(migrationRoot);
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

      console.log('PostgreSQL 16 fresh/upgrade migrations, pending-event delivery, separate-connection claims, fencing, expiry/restart, handler overrun, and rollback checks passed.');
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

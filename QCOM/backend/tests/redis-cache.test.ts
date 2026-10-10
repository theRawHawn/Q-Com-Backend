import assert from 'node:assert/strict';
import {
  cacheSet,
  cacheGet,
  cacheDel,
  cacheIncr,
  acquireLock,
  releaseLock,
  checkRedisHealth,
  inMemoryStore,
} from '../src/database/redis.js';

export async function testRedisCache() {
  console.log('\n--- Running Ephemeral Cache & Distributed Lock Test Suite ---');
  inMemoryStore.clear();

  // 1. Basic KV operations
  await cacheSet('test:key:1', 'hardware_valve_sku', 60);
  const val1 = await cacheGet('test:key:1');
  assert.equal(val1, 'hardware_valve_sku', 'cacheGet must return set value');

  await cacheDel('test:key:1');
  const val2 = await cacheGet('test:key:1');
  assert.equal(val2, null, 'Deleted key must return null');
  console.log('✓ Cache SET, GET, DEL operations verified');

  // 2. Atomic INCR
  const count1 = await cacheIncr('test:counter', 60);
  assert.equal(count1, 1);
  const count2 = await cacheIncr('test:counter', 60);
  assert.equal(count2, 2);
  console.log('✓ Atomic INCR operation verified');

  // 3. Distributed Lock / Mutex (prevents CAS race conditions)
  const lockKey = 'inventory:lock:product-valve-1';
  
  // Acquire lock 1
  const lock1 = await acquireLock(lockKey, 2000, 'worker-token-A');
  assert.equal(lock1.acquired, true, 'First lock acquisition must succeed');
  assert.equal(lock1.token, 'worker-token-A');

  // Concurrent acquisition 2 should fail
  const lock2 = await acquireLock(lockKey, 2000, 'worker-token-B');
  assert.equal(lock2.acquired, false, 'Concurrent acquisition for same key must be rejected');

  // Attempt to release with invalid token should fail
  const invalidRelease = await releaseLock(lockKey, 'wrong-token');
  assert.equal(invalidRelease, false, 'Releasing with mismatched token must be rejected');

  // Release with valid token should succeed
  const validRelease = await releaseLock(lockKey, 'worker-token-A');
  assert.equal(validRelease, true, 'Releasing with matching token must succeed');

  // Now lock can be re-acquired by worker B
  const lock3 = await acquireLock(lockKey, 2000, 'worker-token-B');
  assert.equal(lock3.acquired, true, 'Lock must be acquirable after release');
  await releaseLock(lockKey, 'worker-token-B');
  console.log('✓ Distributed CAS Mutex (acquire, rejection, token safety, release) verified');

  // 4. Health Check Probe
  const health = await checkRedisHealth();
  assert.equal(health.alive, true);
  assert.ok(['redis', 'memory'].includes(health.mode));
  console.log(`✓ Ephemeral cache health check probe verified (mode: ${health.mode})`);
}

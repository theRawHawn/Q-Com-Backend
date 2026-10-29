import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { setPool } from '../src/database/connection.js';
import { createTestDatabase } from './helpers/testDb.js';

export async function testAppHealth() {
  console.log('\n--- Running App Liveness & Readiness Probes Test Suite ---');
  const { pool } = createTestDatabase();
  setPool(pool);

  const app = createApp();
  const trustProxy = app.get('trust proxy fn') as (address: string, hop: number) => boolean;
  assert.equal(trustProxy('203.0.113.7', 0), false, 'Forwarded IP headers must not be trusted without configured proxy CIDRs');

  // Helper to simulate request through Express app
  const simulateRequest = (
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; headers: Record<string, any>; body: any }> => {
    return new Promise((resolve) => {
      const req: any = {
        method,
        url: path,
        originalUrl: path,
        baseUrl: '',
        path,
        headers: { host: 'localhost:4000', ...headers },
        query: {},
        params: {},
        body: {},
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
      };

      const resHeaders: Record<string, any> = {};
      let statusCode = 200;

      const res: any = {
        setHeader(k: string, v: string) { resHeaders[k.toLowerCase()] = v; },
        getHeader(k: string) { return resHeaders[k.toLowerCase()]; },
        removeHeader(k: string) { delete resHeaders[k.toLowerCase()]; },
        status(code: number) { statusCode = code; return this; },
        json(body: any) {
          resolve({ status: statusCode, headers: resHeaders, body });
        },
        send(body: any) {
          resolve({ status: statusCode, headers: resHeaders, body });
        },
      };

      (app as any).handle(req, res, () => {
        resolve({ status: statusCode, headers: resHeaders, body: null });
      });
    });
  };

  try {
    // 1. Liveness Probe /health
    const healthRes = await simulateRequest('GET', '/health');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.body.success, true);
    assert.equal(healthRes.body.status, 'OK');
    assert.equal(healthRes.body.service, 'qcom-backend');
    assert.ok(healthRes.headers['x-request-id']);
    assert.equal(healthRes.headers['x-content-type-options'], 'nosniff');
    console.log('✓ /health process liveness probe verified (200 OK)');

    // 2. Readiness Probe /ready with operational DB
    const readyRes = await simulateRequest('GET', '/ready');
    assert.equal(readyRes.status, 200);
    assert.equal(readyRes.body.success, true);
    assert.equal(readyRes.body.status, 'READY');
    assert.equal(readyRes.body.database.status, 'UP');
    assert.ok(['UP', 'DEGRADED'].includes(readyRes.body.cache.status));
    console.log('✓ /ready authoritative database & cache readiness probe verified (200 READY)');

    // 3. API v1 Foundation Endpoint
    const apiRes = await simulateRequest('GET', '/api/v1');
    assert.equal(apiRes.status, 200);
    assert.equal(apiRes.body.success, true);
    assert.equal(apiRes.body.version, '1.0.0');
    console.log('✓ /api/v1 API router foundation endpoint verified');

    // 4. 404 Handler for Unknown Routes
    const notFoundRes = await simulateRequest('GET', '/unknown/route/path');
    assert.equal(notFoundRes.status, 404);
    assert.equal(notFoundRes.body.success, false);
    assert.equal(notFoundRes.body.error.code, 'NOT_FOUND');
    console.log('✓ 404 Not Found JSON error response verified');

  } finally {
    setPool(null);
    await pool.end();
  }
}

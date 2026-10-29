import assert from 'node:assert/strict';
import {
  requestIdMiddleware,
  securityHeadersMiddleware,
  sanitizationMiddleware,
  createSlidingWindowRateLimiter,
  errorHandler,
  AppError,
} from '../src/middleware/index.js';
import { inMemoryStore } from '../src/database/redis.js';

export async function testMiddleware() {
  console.log('\n--- Running Core Middleware Test Suite ---');
  const createMockReqRes = () => {
    const req: any = { baseUrl: '/api', path: '/test', ip: '127.0.0.1', socket: {} };
    const res: any = {
      statusCode: 200,
      headers: {},
      setHeader(k: string, v: string) { this.headers[k] = v; },
      status(code: number) { this.statusCode = code; return this; },
      body: null,
      json(payload: any) { this.body = payload; return this; },
    };
    return { req, res };
  };

  // 1. Request ID Middleware
  {
    const req: any = { headers: {} };
    const res: any = {
      headers: {},
      setHeader(k: string, v: string) { this.headers[k] = v; },
    };
    let nextCalled = false;

    requestIdMiddleware(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled, 'next() must be called');
    assert.ok(req.requestId, 'req.requestId must be set');
    assert.equal(res.headers['X-Request-Id'], req.requestId);
    console.log('✓ Request ID generation & propagation verified');

    // Test with incoming X-Request-Id header
    const customReq: any = { headers: { 'x-request-id': 'custom-req-123' } };
    const customRes: any = {
      headers: {},
      setHeader(k: string, v: string) { this.headers[k] = v; },
    };
    requestIdMiddleware(customReq, customRes, () => {});
    assert.equal(customReq.requestId, 'custom-req-123', 'Pre-existing request ID must be preserved');
    console.log('✓ Request ID preservation verified');
  }

  // 2. Security Headers Middleware
  {
    const req: any = {};
    const res: any = {
      headers: { 'X-Powered-By': 'Express' },
      setHeader(k: string, v: string) { this.headers[k] = v; },
      removeHeader(k: string) { delete this.headers[k]; },
    };
    let nextCalled = false;

    securityHeadersMiddleware(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled);
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.headers['X-XSS-Protection'], '1; mode=block');
    assert.equal(res.headers['X-Frame-Options'], 'SAMEORIGIN');
    assert.equal(res.headers['X-Powered-By'], undefined, 'X-Powered-By header must be removed');
    console.log('✓ Security headers injection and fingerprint removal verified');
  }

  // 3. Sanitization & Prototype Pollution Defense (CWE-20 / Prototype Pollution)
  {
    const maliciousPayload = JSON.parse(`{
      "name": "Heavy Duty Valve",
      "__proto__": { "polluted": true },
      "nested": {
        "constructor": "exploit",
        "tags": ["fastener", { "__proto__": { "admin": true } }]
      }
    }`);

    const req: any = { body: maliciousPayload, query: {} };
    const res: any = {};
    let nextCalled = false;

    sanitizationMiddleware(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled);
    assert.equal(req.body.name, 'Heavy Duty Valve');
    assert.equal(req.body.__proto__.polluted, undefined, '__proto__ key must be stripped from root');
    assert.equal(req.body.nested.constructor, Object, 'constructor injection must be neutralized');
    assert.equal(req.body.nested.tags[1].__proto__.admin, undefined, '__proto__ key must be stripped from arrays');
    console.log('✓ Prototype pollution protection (CWE-20) verified across nested bodies and arrays');
  }

  // 4. Sliding-Window Rate Limiter
  {
    inMemoryStore.clear();
    const testLimiter = createSlidingWindowRateLimiter({
      limit: 3,
      windowSec: 2,
      keyGenerator: () => 'test-client-ip',
      errorMessage: 'Rate limit exceeded in test',
    });

    // Requests 1, 2, 3 should succeed
    for (let i = 1; i <= 3; i++) {
      const { req, res } = createMockReqRes();
      let nextCalled = false;
      await testLimiter(req, res, () => { nextCalled = true; });
      assert.ok(nextCalled, `Request ${i} should be allowed`);
      assert.equal(res.headers['X-RateLimit-Limit'], '3');
      assert.equal(res.headers['X-RateLimit-Remaining'], (3 - i).toString());
    }

    // Request 4 should be throttled (429)
    const { req: blockedReq, res: blockedRes } = createMockReqRes();
    let blockedNext = false;
    await testLimiter(blockedReq, blockedRes, () => { blockedNext = true; });
    assert.equal(blockedNext, false, 'Fourth request must be throttled');
    assert.equal(blockedRes.statusCode, 429);
    assert.equal(blockedRes.body.error.code, 'RATE_LIMIT_EXCEEDED');
    assert.ok(blockedRes.headers['Retry-After']);
    console.log('✓ Sliding-window rate limiter (allowing up to limit, rejecting at 429) verified');
  }

  // 5. Concurrent requests share both identity and source-IP limits.
  {
    inMemoryStore.clear();
    const concurrentLimiter = createSlidingWindowRateLimiter({
      limit: 30,
      windowSec: 60,
      keyGenerator: (req: any) => [
        { key: `identity:${req.identity}` },
        { key: 'ip:shared', limit: 7 },
      ],
      scope: 'test:concurrent',
    });

    const attempts = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const { req, res } = createMockReqRes();
      req.identity = `identity-${index}`;
      let nextCalled = false;
      await concurrentLimiter(req, res, () => { nextCalled = true; });
      return { nextCalled, statusCode: res.statusCode };
    }));

    assert.equal(attempts.filter((attempt) => attempt.nextCalled).length, 7);
    assert.equal(attempts.filter((attempt) => attempt.statusCode === 429).length, 13);
    console.log('✓ Concurrent identity/IP limits reject requests at the shared-IP threshold');
  }

  // 6. Critical limiters fail closed with a safe response when coordination is unavailable.
  {
    const unavailableLimiter = createSlidingWindowRateLimiter(
      { limit: 1, windowSec: 60 },
      async () => { throw new Error('private Redis connection details'); }
    );
    const { req, res } = createMockReqRes();
    let nextCalled = false;
    await unavailableLimiter(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error.code, 'RATE_LIMIT_UNAVAILABLE');
    assert.equal(JSON.stringify(res.body).includes('private Redis connection details'), false);

    const availabilityLimiter = createSlidingWindowRateLimiter(
      { limit: 120, windowSec: 60, failureMode: 'open' },
      async () => { throw new Error('private Redis connection details'); }
    );
    const openResult = createMockReqRes();
    let openNextCalled = false;
    await availabilityLimiter(openResult.req, openResult.res, () => { openNextCalled = true; });
    assert.equal(openNextCalled, true);
    assert.equal(openResult.res.headers['X-RateLimit-Status'], 'unavailable');
    console.log('✓ Limiter outages fail closed for critical routes and are explicitly surfaced for general admission');
  }

  // 5. Error Handler
  {
    const req: any = { requestId: 'req-err-test-456' };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      body: null,
      json(payload: any) { this.body = payload; return this; },
    };

    const customErr: AppError = new Error('Invalid coupon code applied');
    customErr.statusCode = 422;
    customErr.code = 'INVALID_COUPON';

    errorHandler(customErr, req, res, () => {});
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'INVALID_COUPON');
    assert.equal(res.body.error.requestId, 'req-err-test-456');
    console.log('✓ Centralized error handler structured response verified');
  }
}

import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/testDb.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { createApp } from '../src/app.js';
import { setPool } from '../src/database/connection.js';
import { env } from '../src/config/env.js';
import { signAccessToken, verifyAccessToken } from '../src/modules/auth/jwt.js';

export async function testAuthRemediation() {
  console.log('\n===========================================================');
  console.log('  Authentication Security Remediation Test Suite (AUTH-03, AUTH-05, AUTH-11)');
  console.log('===========================================================');

  const { pool } = createTestDatabase();
  setPool(pool);

  try {
    await runMigrations({ poolOverride: pool });
    await runSeeds(pool);

    const authService = new AuthService();
    const app = createApp();

    // Helper for simulated HTTP requests against the Express app
    async function makeRequest(
      path: string,
      options: {
        method?: string;
        token?: string;
        body?: any;
      } = {}
    ) {
      const method = options.method || 'GET';
      const body = options.body || {};
      const token = options.token;

      return new Promise<{ status: number; body: any }>((resolve) => {
        const req: any = {
          method,
          url: path,
          originalUrl: path,
          path: path.split('?')[0],
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            'user-agent': 'RemediationTestRunner',
            'content-type': 'application/json',
          },
          params: {},
          query: {},
          body,
          ip: '127.0.0.1',
          socket: { remoteAddress: '127.0.0.1' },
          baseUrl: '',
        };

        const res: any = {
          statusCode: 200,
          _headers: {},
          setHeader(name: string, val: string) { this._headers[name] = val; },
          status(code: number) { this.statusCode = code; return this; },
          json(data: any) { resolve({ status: this.statusCode, body: data }); },
        };

        (app as any).handle(req, res, () => {
          resolve({ status: 404, body: { error: 'ROUTE_NOT_FOUND' } });
        });
      });
    }

    // =========================================================================
    // SECTION 1: AUTH-03 — ACCESS TOKEN LIFETIME (15 MINUTES)
    // =========================================================================
    console.log('\n[AUTH-03 Test 1] Verifying 15-Minute Access Token Lifetime Configuration...');
    assert.equal(
      env.ACCESS_TOKEN_TTL_MINUTES,
      15,
      'ACCESS_TOKEN_TTL_MINUTES configuration must be effectively 15 minutes'
    );

    const testPayload = {
      sub: 'usr-auth03-test-id',
      session_id: 'ses-auth03-test-id',
      token_version: 1,
      roles: ['CUSTOMER'],
      phone: '+91-9876500000',
    };

    const token15m = signAccessToken(testPayload);
    const decoded15m = verifyAccessToken(token15m);
    const lifetimeSeconds = decoded15m.exp - decoded15m.iat;
    assert.equal(
      lifetimeSeconds,
      15 * 60,
      `Access token exp must be exactly 900 seconds (15 minutes) from iat. Got ${lifetimeSeconds}s`
    );
    console.log(`✓ Access token lifetime verified: exactly ${lifetimeSeconds / 60} minutes (${lifetimeSeconds}s)`);

    console.log('[AUTH-03 Test 2] Verifying Expiry Enforcement on 15-Minute Tokens...');
    const expiredToken = signAccessToken({
      ...testPayload,
      ttlMinutes: -1, // Expired 1 minute ago
    });
    assert.throws(
      () => verifyAccessToken(expiredToken),
      /jwt token has expired/i,
      'Expired access token must be rejected'
    );
    console.log('✓ Expired access token strictly rejected');

    // =========================================================================
    // SECTION 2: AUTH-05 — CONCURRENT REFRESH TOKEN ROTATION RACE CONDITION
    // =========================================================================
    console.log('\n[AUTH-05 Test 1] Testing Single Legitimate Refresh Rotation...');
    const userPhone1 = '+91-9111100001';
    const otp1 = await authService.requestOtp(userPhone1, 'LOGIN', '127.0.0.1', pool);
    const login1 = await authService.verifyOtp(userPhone1, otp1.debugOtp!, 'LOGIN', '127.0.0.1', 'TestDevice', 'User 1', pool);

    assert.ok(login1.refreshToken);
    const initialRefresh = login1.refreshToken;

    // First rotation should succeed cleanly
    const rotate1 = await authService.refreshTokens(initialRefresh, '127.0.0.1', 'TestDevice', pool);
    assert.ok(rotate1.accessToken);
    assert.ok(rotate1.refreshToken);
    assert.notEqual(rotate1.refreshToken, initialRefresh);
    console.log('✓ Single legitimate refresh rotation succeeded');

    console.log('[AUTH-05 Test 2] Testing Replay of Rotated Token (Family Invalidation)...');
    await assert.rejects(
      async () => {
        await authService.refreshTokens(initialRefresh, '127.0.0.1', 'TestDevice', pool);
      },
      /reuse detected/i,
      'Replay of rotated token must trigger reuse detection and revoke family'
    );

    const revokedSessionCheck = await pool.query(
      `SELECT status FROM auth_sessions WHERE id = $1`,
      [login1.session.id]
    );
    assert.equal(revokedSessionCheck.rows[0].status, 'REVOKED');
    console.log('✓ Replay detection correctly invalidated entire token family and session');

    console.log('[AUTH-05 Test 3] Testing Concurrent Refresh Token Race Condition...');
    // Create fresh session for concurrency test
    const userPhone2 = '+91-9111100002';
    const otp2 = await authService.requestOtp(userPhone2, 'LOGIN', '127.0.0.1', pool);
    const login2 = await authService.verifyOtp(userPhone2, otp2.debugOtp!, 'LOGIN', '127.0.0.1', 'TestDevice', 'User 2', pool);
    const concurrentToken = login2.refreshToken;

    // Simulate 2 parallel refresh requests with the EXACT same refresh token simultaneously
    const results = await Promise.allSettled([
      authService.refreshTokens(concurrentToken, '127.0.0.1', 'DeviceA', pool),
      authService.refreshTokens(concurrentToken, '127.0.0.1', 'DeviceB', pool),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Invariant 2: Two concurrent refresh requests cannot both succeed
    assert.equal(
      fulfilled.length,
      1,
      `Exactly one concurrent refresh request must succeed. Found fulfilled: ${fulfilled.length}, rejected: ${rejected.length}`
    );
    assert.equal(
      rejected.length,
      1,
      `The conflicting concurrent refresh request must be rejected. Found: ${rejected.length}`
    );

    // Invariant 3 & 5: Exactly one active replacement token created in database for this session
    const activeTokens = await pool.query(
      `SELECT id, token_hash, is_revoked, rotated_at 
       FROM refresh_tokens 
       WHERE session_id = $1 AND is_revoked = FALSE AND rotated_at IS NULL`,
      [login2.session.id]
    );
    assert.equal(
      activeTokens.rows.length,
      1,
      `Must have exactly 1 active unrevoked replacement token after concurrent race. Found: ${activeTokens.rows.length}`
    );
    console.log('✓ Concurrent refresh race condition prevented: exactly one winner, zero duplicate replacement tokens');

    // =========================================================================
    // SECTION 3: AUTH-11 — POST /auth/logout-all
    // =========================================================================
    console.log('\n[AUTH-11 Test 1] Testing Unauthenticated POST /auth/logout-all...');
    const unauthRes = await makeRequest('/api/v1/auth/logout-all', { method: 'POST' });
    assert.equal(unauthRes.status, 401, 'Unauthenticated request must be rejected with 401');
    assert.equal(unauthRes.body.error, 'UNAUTHENTICATED');
    console.log('✓ Unauthenticated logout-all rejected with 401 UNAUTHENTICATED');

    console.log('[AUTH-11 Test 2] Testing Multi-Session Logout-All for Authenticated User...');
    const userPhone3 = '+91-9111100003';
    // Create first session via OTP login
    const otp3a = await authService.requestOtp(userPhone3, 'LOGIN', '127.0.0.1', pool);
    const session1 = await authService.verifyOtp(userPhone3, otp3a.debugOtp!, 'LOGIN', '127.0.0.1', 'WebBrowser', 'MultiUser', pool);

    // Create session 2 (Mobile App) and session 3 (Tablet App) for the same user identity
    const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const s2Res = await pool.query(
      `INSERT INTO auth_sessions (user_id, token_version, status, ip_address, user_agent, expires_at, created_at, last_seen_at)
       VALUES ($1, 1, 'ACTIVE', '127.0.0.1', 'MobileApp', $2, NOW(), NOW())
       RETURNING id, expires_at`,
      [session1.user.id, sessionExpiresAt]
    );
    const session2Id = s2Res.rows[0].id;
    const session2Token = signAccessToken({
      sub: session1.user.id,
      session_id: session2Id,
      token_version: 1,
      roles: session1.user.roles,
      phone: session1.user.phone,
    });
    await pool.query(
      `INSERT INTO refresh_tokens (session_id, user_id, token_hash, family_id, is_revoked, expires_at, created_at)
       VALUES ($1, $2, $3, gen_random_uuid(), FALSE, $4, NOW())`,
      [session2Id, session1.user.id, 'hash_refresh_token_session_2', sessionExpiresAt]
    );

    const s3Res = await pool.query(
      `INSERT INTO auth_sessions (user_id, token_version, status, ip_address, user_agent, expires_at, created_at, last_seen_at)
       VALUES ($1, 1, 'ACTIVE', '127.0.0.1', 'TabletApp', $2, NOW(), NOW())
       RETURNING id, expires_at`,
      [session1.user.id, sessionExpiresAt]
    );
    const session3Id = s3Res.rows[0].id;
    const session3Token = signAccessToken({
      sub: session1.user.id,
      session_id: session3Id,
      token_version: 1,
      roles: session1.user.roles,
      phone: session1.user.phone,
    });
    await pool.query(
      `INSERT INTO refresh_tokens (session_id, user_id, token_hash, family_id, is_revoked, expires_at, created_at)
       VALUES ($1, $2, $3, gen_random_uuid(), FALSE, $4, NOW())`,
      [session3Id, session1.user.id, 'hash_refresh_token_session_3', sessionExpiresAt]
    );

    // Verify all 3 sessions are initially ACTIVE
    const preCheck = await pool.query(
      `SELECT count(*) as count FROM auth_sessions WHERE user_id = $1 AND status = 'ACTIVE'`,
      [session1.user.id]
    );
    assert.equal(Number(preCheck.rows[0].count), 3, 'User must have 3 active sessions before logout-all');

    // Also create an isolated Session for User 4 to test Tenant Isolation
    const userPhone4 = '+91-9111100004';
    const otp4 = await authService.requestOtp(userPhone4, 'LOGIN', '127.0.0.1', pool);
    const user4Session = await authService.verifyOtp(userPhone4, otp4.debugOtp!, 'LOGIN', '127.0.0.1', 'OtherUserDevice', 'OtherUser', pool);

    // User 3 calls POST /api/v1/auth/logout-all using session 1's token
    const logoutAllRes = await makeRequest('/api/v1/auth/logout-all', {
      method: 'POST',
      token: session1.accessToken,
    });
    assert.equal(logoutAllRes.status, 200, 'Logout-all must succeed with 200');
    assert.equal(logoutAllRes.body.success, true);
    assert.equal(logoutAllRes.body.revokedSessionsCount, 3, 'Must report all 3 sessions revoked');
    console.log(`✓ POST /api/v1/auth/logout-all revoked ${logoutAllRes.body.revokedSessionsCount} active sessions`);

    console.log('[AUTH-11 Test 3] Verifying All User Sessions & Refresh Tokens are REVOKED in PostgreSQL...');
    const postSessions = await pool.query(
      `SELECT id, status FROM auth_sessions WHERE user_id = $1`,
      [session1.user.id]
    );
    for (const row of postSessions.rows) {
      assert.equal(row.status, 'REVOKED', `Session ${row.id} must be REVOKED`);
    }

    const postTokens = await pool.query(
      `SELECT id, is_revoked FROM refresh_tokens WHERE user_id = $1`,
      [session1.user.id]
    );
    for (const row of postTokens.rows) {
      assert.equal(row.is_revoked, true, `Refresh token ${row.id} must be revoked`);
    }
    console.log('✓ All 3 sessions and associated refresh tokens verified REVOKED in database');

    console.log('[AUTH-11 Test 4] Verifying In-Flight Access JWTs from All Sessions are Rejected...');
    // Test access tokens from all 3 sessions
    const req1 = await makeRequest('/api/v1/auth/me', { token: session1.accessToken });
    assert.equal(req1.status, 401);
    assert.equal(req1.body.error, 'SESSION_REVOKED');

    const req2 = await makeRequest('/api/v1/auth/me', { token: session2Token });
    assert.equal(req2.status, 401);
    assert.equal(req2.body.error, 'SESSION_REVOKED');

    const req3 = await makeRequest('/api/v1/auth/me', { token: session3Token });
    assert.equal(req3.status, 401);
    assert.equal(req3.body.error, 'SESSION_REVOKED');
    console.log('✓ In-flight access JWTs from all revoked sessions rejected with 401 SESSION_REVOKED');

    console.log('[AUTH-11 Test 5] Verifying User Isolation: Other User Sessions Remain Active...');
    const user4Req = await makeRequest('/api/v1/auth/me', { token: user4Session.accessToken });
    assert.equal(user4Req.status, 200, 'Other user session must remain unaffected and active');
    assert.equal(user4Req.body.user.id, user4Session.user.id);
    console.log('✓ User boundary isolated: Other user session remains completely active');

    console.log('[AUTH-11 Test 6] Testing Repeated Calls & Current-Session Logout...');
    // Calling logoutAll directly on service with 0 active sessions should safely return 0
    const repeatedServiceCall = await authService.logoutAll(session1.user.id, '127.0.0.1', 'TestDevice', pool);
    assert.equal(repeatedServiceCall.revokedSessionsCount, 0);
    assert.equal(repeatedServiceCall.revokedTokensCount, 0);

    // Existing single-session logout still works for active session of User 4
    const singleLogoutRes = await makeRequest('/api/v1/auth/logout', {
      method: 'POST',
      token: user4Session.accessToken,
    });
    assert.equal(singleLogoutRes.status, 200, 'Standard single-session logout must continue working');
    assert.equal(singleLogoutRes.body.success, true);

    const user4PostLogout = await makeRequest('/api/v1/auth/me', { token: user4Session.accessToken });
    assert.equal(user4PostLogout.status, 401);
    assert.equal(user4PostLogout.body.error, 'SESSION_REVOKED');
    console.log('✓ Existing single-session logout functionality verified intact');

    console.log('\n===========================================================');
    console.log('✓ ALL AUTHENTICATION REMEDIATION TESTS PASSED (AUTH-03, AUTH-05, AUTH-11)!');
    console.log('===========================================================');

  } finally {
    setPool(null);
    await pool.end();
  }
}

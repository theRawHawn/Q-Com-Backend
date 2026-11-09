import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/testDb.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { AuthService } from '../src/modules/auth/authService.js';
import { RbacService } from '../src/modules/rbac/rbacService.js';
import { MockOtpProvider } from '../src/modules/auth/otpProvider.js';
import { hashOtp } from '../src/modules/auth/crypto.js';
import { validateProductionSecurity } from '../src/config/env.js';

export async function testAuthAndRbac() {
  console.log('\n--- Running Authentication, Sessions & Dynamic RBAC Test Suite ---');
  const { pool } = createTestDatabase();

  try {
    await runMigrations({ poolOverride: pool });
    await runSeeds(pool);

    const authService = new AuthService();
    const rbacService = new RbacService();

    // =========================================================================
    // 1. OTP REQUEST & SECURITY CONTROLS
    // =========================================================================
    console.log('[Test 1] Testing OTP Request & Sliding Window Rate Limiting...');
    const testPhone = '+91-9999900001';

    // 1.1 Request 1: Valid OTP Request
    const otpRes1 = await authService.requestOtp(testPhone, 'LOGIN', '127.0.0.1', pool);
    assert.ok(otpRes1.success);
    assert.ok(otpRes1.debugOtp, 'Debug OTP should be available in test mode');
    assert.equal(otpRes1.debugOtp.length, 6);

    // 1.2 Resend Cooldown Check: Immediate retry should be rejected (cooldown period)
    await assert.rejects(
      async () => {
        await authService.requestOtp(testPhone, 'LOGIN', '127.0.0.1', pool);
      },
      /wait.*s before requesting/i,
      'Immediate OTP resend within cooldown window should be rejected'
    );

    // 1.3 OTP Challenge stored in database with hashed OTP
    const challengeDb = await pool.query(
      `SELECT otp_hash, is_consumed, attempt_count FROM otp_challenges WHERE phone = $1`,
      [testPhone]
    );
    assert.equal(challengeDb.rows.length, 1);
    assert.equal(challengeDb.rows[0].is_consumed, false);
    assert.notEqual(challengeDb.rows[0].otp_hash, otpRes1.debugOtp, 'Raw OTP must NEVER be stored plaintext in database');
    const expectedHash = hashOtp(testPhone, otpRes1.debugOtp!, 'LOGIN');
    assert.equal(challengeDb.rows[0].otp_hash, expectedHash);
    console.log('✓ OTP generation, cryptographic hashing, and cooldown enforcement verified');

    // =========================================================================
    // 2. OTP VERIFICATION, ATTEMPT LIMITING & SINGLE-USE CONSUMPTION
    // =========================================================================
    console.log('[Test 2] Testing OTP Verification, Attempt Limiting & Consumption...');

    // 2.1 Invalid OTP should be rejected and increment attempt count
    await assert.rejects(
      async () => {
        await authService.verifyOtp(testPhone, '000000', 'LOGIN', '127.0.0.1', 'TestAgent', undefined, pool);
      },
      /invalid otp/i,
      'Invalid OTP should be rejected'
    );

    const attemptRes = await pool.query(`SELECT attempt_count FROM otp_challenges WHERE phone = $1`, [testPhone]);
    assert.equal(attemptRes.rows[0].attempt_count, 1);

    // 2.2 Valid OTP verification should succeed and return AuthResult
    const authResult = await authService.verifyOtp(testPhone, otpRes1.debugOtp!, 'LOGIN', '127.0.0.1', 'TestAgent', 'Test User 1', pool);
    assert.ok(authResult.accessToken);
    assert.ok(authResult.refreshToken);
    assert.ok(authResult.user.id);
    assert.equal(authResult.user.phone, testPhone);
    assert.ok(authResult.user.roles.includes('CUSTOMER'), 'New user should receive default CUSTOMER role');

    // 2.3 Single-Use: Replay of consumed OTP must fail
    await assert.rejects(
      async () => {
        await authService.verifyOtp(testPhone, otpRes1.debugOtp!, 'LOGIN', '127.0.0.1', 'TestAgent', undefined, pool);
      },
      /no active otp request/i,
      'Replay of already consumed OTP must be rejected'
    );
    console.log('✓ OTP verification, user onboarding, and single-use replay protection verified');

    // =========================================================================
    // 3. AUTHORITATIVE SESSION IN POSTGRESQL & REFRESH TOKEN ROTATION
    // =========================================================================
    console.log('[Test 3] Testing Authoritative PostgreSQL Sessions & Token Family Rotation...');

    // 3.1 Session record in DB
    const sessionRes = await pool.query(
      `SELECT status, user_id, expires_at FROM auth_sessions WHERE id = $1`,
      [authResult.session.id]
    );
    assert.equal(sessionRes.rows.length, 1);
    assert.equal(sessionRes.rows[0].status, 'ACTIVE');

    // 3.2 Refresh tokens stored as hash (never plaintext)
    const tokenDb = await pool.query(
      `SELECT token_hash, family_id, is_revoked FROM refresh_tokens WHERE session_id = $1`,
      [authResult.session.id]
    );
    assert.equal(tokenDb.rows.length, 1);
    assert.equal(tokenDb.rows[0].is_revoked, false);
    assert.notEqual(tokenDb.rows[0].token_hash, authResult.refreshToken, 'Refresh token must be hashed in DB');

    // 3.3 Valid Refresh Token Rotation
    const rotatedResult = await authService.refreshTokens(authResult.refreshToken, '127.0.0.1', 'TestAgent', pool);
    assert.ok(rotatedResult.accessToken);
    assert.ok(rotatedResult.refreshToken);
    assert.notEqual(rotatedResult.refreshToken, authResult.refreshToken, 'Refresh token must rotate to a new string');

    // 3.4 Previous Refresh Token is now marked rotated/revoked
    const prevTokenDb = await pool.query(
      `SELECT is_revoked, rotated_at FROM refresh_tokens WHERE token_hash = $1`,
      [tokenDb.rows[0].token_hash]
    );
    assert.equal(prevTokenDb.rows[0].is_revoked, true);
    assert.ok(prevTokenDb.rows[0].rotated_at);

    // 3.5 REUSE DETECTION: Replaying the old (rotated) refresh token must revoke the whole family & session!
    await assert.rejects(
      async () => {
        await authService.refreshTokens(authResult.refreshToken, '127.0.0.1', 'TestAgent', pool);
      },
      /reuse detected/i,
      'Reusing a rotated refresh token must trigger reuse detection and throw'
    );

    // Verify session and all tokens in family were invalidated
    const revokedSession = await pool.query(`SELECT status FROM auth_sessions WHERE id = $1`, [authResult.session.id]);
    assert.equal(revokedSession.rows[0].status, 'REVOKED');
    console.log('✓ Session state ledger, token rotation, and refresh token reuse detection verified');

    // =========================================================================
    // 4. LOGOUT & SERVER-SIDE REVOCATION
    // =========================================================================
    console.log('[Test 4] Testing Explicit Logout and Server-Side Revocation...');
    
    // Create new session for user
    const login2 = await authService.adminLogin('EMP-001', undefined, '127.0.0.1', 'AdminBrowser', pool);
    assert.ok(login2.session.id);

    // Logout
    await authService.logout(login2.session.id, login2.user.id, '127.0.0.1', 'AdminBrowser', pool);

    const postLogoutSession = await pool.query(`SELECT status FROM auth_sessions WHERE id = $1`, [login2.session.id]);
    assert.equal(postLogoutSession.rows[0].status, 'REVOKED');
    console.log('✓ Server-side session revocation on logout verified');

    // =========================================================================
    // 5. ACCOUNT SUSPENSION ENFORCEMENT
    // =========================================================================
    console.log('[Test 5] Testing Account Suspension Enforcement...');
    const suspendedPhone = '+91-9999900099';

    // Create user and suspend
    const suspUserRes = await pool.query(
      `INSERT INTO users (phone, name, is_suspended, suspension_reason)
       VALUES ($1, 'Suspended Contractor', TRUE, 'Fraudulent documentation')
       RETURNING id`,
      [suspendedPhone]
    );
    const suspUserId = suspUserRes.rows[0].id;

    // Request OTP for suspended user (allowed)
    const suspOtp = await authService.requestOtp(suspendedPhone, 'LOGIN', '127.0.0.1', pool);

    // Verification must fail with 403 Account Suspended
    await assert.rejects(
      async () => {
        await authService.verifyOtp(suspendedPhone, suspOtp.debugOtp!, 'LOGIN', '127.0.0.1', 'TestAgent', undefined, pool);
      },
      /account suspended/i,
      'Suspended user must be blocked from logging in'
    );
    console.log('✓ Account suspension blocks login and session creation');

    // =========================================================================
    // 6. DYNAMIC RBAC & PERMISSIONS MANAGEMENT
    // =========================================================================
    console.log('[Test 6] Testing Database-Backed Dynamic RBAC & Role Management...');

    // 6.1 Create Dynamic Role
    const newRole = await rbacService.createRole({
      code: 'REGIONAL_AUDITOR',
      name: 'Regional Tax Auditor',
      description: 'Audits GST and TDS filings across regional hubs',
      actorId: login2.user.id,
    }, pool);
    assert.ok(newRole.id);
    assert.equal(newRole.code, 'REGIONAL_AUDITOR');

    // 6.2 Assign Permission to Dynamic Role
    const allPerms = await rbacService.listPermissions(pool);
    const auditPerm = allPerms.find(p => p.key === 'audit.view');
    assert.ok(auditPerm);

    await rbacService.assignPermissionToRole(newRole.id, auditPerm.id, login2.user.id, pool);

    // 6.3 Assign Dynamic Role to User
    await rbacService.assignRoleToUser(authResult.user.id, newRole.id, login2.user.id, pool);

    const userPerms = await rbacService.getUserPermissions(authResult.user.id, pool);
    assert.ok(userPerms.includes('audit.view'), 'User should dynamically receive assigned permission');

    // 6.4 Remove Role from User
    await rbacService.removeRoleFromUser(authResult.user.id, newRole.id, login2.user.id, pool);
    const userPermsAfter = await rbacService.getUserPermissions(authResult.user.id, pool);
    assert.equal(userPermsAfter.includes('audit.view'), false, 'Permission should disappear after role revocation');
    console.log('✓ Dynamic role creation, permission mapping, and role assignment/revocation verified');

    // =========================================================================
    // 7. SECURITY AUDIT LOGS
    // =========================================================================
    console.log('[Test 7] Testing Security Audit Logging & Sanitization...');
    const auditRes = await pool.query(
      `SELECT action, actor_type, old_state, new_state FROM audit_logs ORDER BY created_at DESC LIMIT 10`
    );
    assert.ok(auditRes.rows.length >= 5, 'Expected security audit logs to be persisted');

    // Verify no plain secrets leaked in audit logs
    for (const log of auditRes.rows) {
      const logStr = JSON.stringify(log);
      assert.equal(logStr.includes(otpRes1.debugOtp!), false, 'Raw OTP must NEVER appear in audit log payload');
      assert.equal(logStr.includes(authResult.refreshToken), false, 'Raw refresh token must NEVER appear in audit log payload');
    }
    console.log(`✓ Verified ${auditRes.rows.length} security audit events recorded without leaking plain secrets`);

    // =========================================================================
    // 8. PRODUCTION FAIL-CLOSED CONFIGURATION VALIDATION
    // =========================================================================
    console.log('[Test 8] Testing Production Fail-Closed Security Validation...');
    assert.throws(
      () => {
        validateProductionSecurity({
          NODE_ENV: 'production',
          JWT_ACCESS_SECRET: 'qcom_dev_access_secret_2026_super_secure_key', // Default dev key
          JWT_REFRESH_SECRET: 'secure_key_123456789012345678901234567890',
          TELEPHONY_MODE: 'exotel',
          CORS_ALLOWED_ORIGINS: 'https://admin.qcom.in',
        } as any);
      },
      /requires a high-entropy JWT_ACCESS_SECRET/i,
      'Production startup must fail on default development secrets'
    );

    assert.throws(
      () => {
        validateProductionSecurity({
          NODE_ENV: 'production',
          JWT_ACCESS_SECRET: 'prod_ultra_secure_secret_key_12345678901234567890',
          JWT_REFRESH_SECRET: 'prod_ultra_secure_secret_key_12345678901234567890',
          TELEPHONY_MODE: 'mock', // Prohibited in prod
          CORS_ALLOWED_ORIGINS: 'https://admin.qcom.in',
        } as any);
      },
      /Mock OTP.*prohibited in production/i,
      'Production startup must fail if mock OTP provider is enabled'
    );

    assert.throws(
      () => {
        validateProductionSecurity({
          NODE_ENV: 'production',
          JWT_ACCESS_SECRET: 'prod_ultra_secure_secret_key_12345678901234567890',
          JWT_REFRESH_SECRET: 'prod_ultra_secure_secret_key_12345678901234567890',
          TELEPHONY_MODE: 'exotel',
          PAYMENT_MODE: 'production',
          RAZORPAY_KEY_ID: 'rzp_test_mockkey123',
          RAZORPAY_KEY_SECRET: 'prod_secret_key_1234567890',
          PAYMENT_SECRET: 'custom_payment_secret_prod_1234567890',
          RAZORPAY_WEBHOOK_SECRET: 'custom_webhook_secret_prod_1234567890',
          CORS_ALLOWED_ORIGINS: 'https://admin.qcom.in',
        } as any);
      },
      /Test key ID \(rzp_test_\*\) cannot be used for live payments in production/i,
      'Production startup must fail if test Razorpay key ID is passed'
    );

    assert.throws(
      () => {
        validateProductionSecurity({
          NODE_ENV: 'test',
          RAZORPAY_KEY_ID: 'rzp_live_productionkey123',
        } as any);
      },
      /Live payment credentials cannot be used in test environment/i,
      'Test startup must fail if live Razorpay credentials are used'
    );

    console.log('✓ Production fail-closed security configuration rules verified');

  } finally {
    await pool.end();
  }
}

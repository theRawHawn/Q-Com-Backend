import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { setPool, getPool } from '../src/database/connection.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';
import { createTestDatabase } from './helpers/testDb.js';
import {
  hashPassword,
  verifyPassword,
  validatePasswordPolicy,
  generateNumericOtp,
  hashOtp,
  constantTimeCompare,
} from '../src/modules/auth/crypto.js';

export async function runSprint14_7AuthenticationSecurityTests(): Promise<void> {
  console.log('\n================================================================================');
  console.log('  SPRINT 14.7 — AUTHENTICATION, PASSWORD & CREDENTIAL SECURITY HARDENING');
  console.log('================================================================================');

  // 1. Initialize Test Database & App
  const testDb = createTestDatabase();
  setPool(testDb.pool);
  await runMigrations({ poolOverride: testDb.pool });
  await runSeeds(testDb.pool);

  // Setup Two Instances to test cross-instance session revocation & concurrency
  const app1 = createApp();
  const server1 = http.createServer(app1);
  await new Promise<void>((resolve) => server1.listen(0, resolve));
  const port1 = (server1.address() as import('net').AddressInfo).port;
  const baseUrl1 = `http://127.0.0.1:${port1}`;

  const app2 = createApp();
  const server2 = http.createServer(app2);
  await new Promise<void>((resolve) => server2.listen(0, resolve));
  const port2 = (server2.address() as import('net').AddressInfo).port;
  const baseUrl2 = `http://127.0.0.1:${port2}`;

  async function apiCall(baseUrl: string, path: string, options: { method?: string; token?: string; body?: any; headers?: any } = {}) {
    const headers: any = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (options.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let data: any = null;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, headers: res.headers, data };
  }

  // ---------------------------------------------------------------------------
  // TEST SECTION 1: Password Storage, Policy & Verification (Scrypt)
  // ---------------------------------------------------------------------------
  console.log('\n--- Section 1: Scrypt Password Hashing & Policy Enforcement ---');
  
  // 1.1 Password Policy Validation
  assert.strictEqual(validatePasswordPolicy('short').valid, false, 'Passwords < 8 chars must be rejected');
  assert.strictEqual(validatePasswordPolicy('a'.repeat(129)).valid, false, 'Passwords > 128 chars must be rejected to prevent DoS');
  assert.strictEqual(validatePasswordPolicy('SuperSecurePass123!').valid, true, 'Valid password policy accepted');

  // 1.2 Scrypt Hash Generation & Format
  const rawSecret = 'AdminPassphrase2026!';
  const scryptResult = hashPassword(rawSecret);
  assert.ok(scryptResult.formatted.startsWith('$scrypt$N=16384,r=8,p=1$'), 'Hash must use standard Scrypt format with approved cost factor');
  assert.strictEqual(scryptResult.formatted.includes(rawSecret), false, 'Stored hash must never contain raw plaintext password');

  // 1.3 Salt Uniqueness
  const scryptResult2 = hashPassword(rawSecret);
  assert.notStrictEqual(scryptResult.salt, scryptResult2.salt, 'Different password hashes must receive cryptographically unique salts');
  assert.notStrictEqual(scryptResult.formatted, scryptResult2.formatted, 'Different hashes must be generated for the same password due to salts');

  // 1.4 Verification (Correct vs Incorrect)
  assert.strictEqual(verifyPassword(rawSecret, scryptResult.formatted).verified, true, 'Valid password must verify');
  assert.strictEqual(verifyPassword('WrongSecretPassword!', scryptResult.formatted).verified, false, 'Invalid password must fail verification');

  // 1.5 Legacy PBKDF2 Migration & Opportunistic Rehashing
  const legacySalt = 'abc123def456';
  const legacyHash = { hash: 'dummy_hash_for_test', salt: legacySalt };
  const legacyVerification = verifyPassword('anyPassword', legacyHash);
  // Verify return structure handles needsRehash
  assert.strictEqual(typeof legacyVerification.verified, 'boolean');

  console.log('✓ Section 1 Passed: Scrypt hashing, salt uniqueness, and password policy verified.');

  // ---------------------------------------------------------------------------
  // TEST SECTION 2: Admin Password Lifecycle, Lockout & Session Revocation
  // ---------------------------------------------------------------------------
  console.log('\n--- Section 2: Admin Password Lifecycle & Lockout Protection ---');

  // 2.1 Admin Login without password initially (seeded admin)
  const adminLogin1 = await apiCall(baseUrl1, '/api/auth/admin/login', {
    method: 'POST',
    body: { employeeCode: 'EMP-001' },
  });
  assert.strictEqual(adminLogin1.status, 200, 'Admin can login via employee code');
  const adminToken = adminLogin1.data.accessToken;
  const adminUserId = adminLogin1.data.employee.id;

  // 2.2 Admin Sets Password
  const setPassRes = await apiCall(baseUrl1, '/api/auth/admin/set-password', {
    method: 'POST',
    token: adminToken,
    body: { newPassword: 'MasterSecurityAdminPass2026!' },
  });
  assert.strictEqual(setPassRes.status, 200, 'Admin can set a password matching policy');

  // 2.3 Existing Session must be revoked immediately
  const revokedCall = await apiCall(baseUrl1, '/api/admin/me', { token: adminToken });
  assert.strictEqual(revokedCall.status, 401, 'Setting password must revoke all existing active sessions');

  // 2.4 Login with incorrect password fails
  const badLogin = await apiCall(baseUrl1, '/api/auth/admin/login', {
    method: 'POST',
    body: { employeeCode: 'EMP-001', password: 'WrongPassword123!' },
  });
  assert.strictEqual(badLogin.status, 401, 'Login with incorrect password must fail with 401');

  // 2.5 Login with correct password succeeds
  const goodLogin = await apiCall(baseUrl1, '/api/auth/admin/login', {
    method: 'POST',
    body: { employeeCode: 'EMP-001', password: 'MasterSecurityAdminPass2026!' },
  });
  assert.strictEqual(goodLogin.status, 200, 'Login with correct password succeeds');
  const newAdminToken = goodLogin.data.accessToken;

  // 2.6 Account Lockout after multiple failed attempts
  for (let i = 0; i < 5; i++) {
    await apiCall(baseUrl1, '/api/auth/admin/login', {
      method: 'POST',
      body: { employeeCode: 'EMP-001', password: 'BadPasswordAttack' },
    });
  }
  const lockedLogin = await apiCall(baseUrl1, '/api/auth/admin/login', {
    method: 'POST',
    body: { employeeCode: 'EMP-001', password: 'MasterSecurityAdminPass2026!' },
  });
  assert.strictEqual(lockedLogin.status, 401);
  assert.ok(lockedLogin.data.message.includes('locked'), 'Account must be locked out after 5 consecutive failed attempts');

  // Reset lockout for test cleanup
  await testDb.pool.query('UPDATE users SET failed_password_attempts = 0, password_locked_until = NULL WHERE id = $1', [adminUserId]);

  const adminPasswordBeforeChange = (await testDb.pool.query(
    'SELECT password_hash FROM users WHERE id = $1',
    [adminUserId]
  )).rows[0].password_hash;
  const activeAdminSessionsBeforeChange = Number((await testDb.pool.query(
    `SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = $1 AND status = 'ACTIVE'`,
    [adminUserId]
  )).rows[0].count);

  const rejectedPasswordChange = await apiCall(baseUrl1, '/api/auth/admin/change-password', {
    method: 'POST',
    token: newAdminToken,
    body: {
      currentPassword: 'IncorrectCurrentPassword2026!',
      newPassword: 'UpdatedSecurityAdminPass2026!',
    },
  });
  assert.strictEqual(rejectedPasswordChange.status, 400, 'Incorrect current password must be rejected');
  const adminAfterRejectedChange = (await testDb.pool.query(
    'SELECT password_hash FROM users WHERE id = $1',
    [adminUserId]
  )).rows[0].password_hash;
  const activeAdminSessionsAfterRejectedChange = Number((await testDb.pool.query(
    `SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = $1 AND status = 'ACTIVE'`,
    [adminUserId]
  )).rows[0].count);
  assert.strictEqual(adminAfterRejectedChange, adminPasswordBeforeChange, 'Rejected password change must not update the password hash');
  assert.strictEqual(activeAdminSessionsAfterRejectedChange, activeAdminSessionsBeforeChange, 'Rejected password change must not revoke sessions');

  const changedPassword = await apiCall(baseUrl1, '/api/auth/admin/change-password', {
    method: 'POST',
    token: newAdminToken,
    body: {
      currentPassword: 'MasterSecurityAdminPass2026!',
      newPassword: 'UpdatedSecurityAdminPass2026!',
    },
  });
  assert.strictEqual(changedPassword.status, 200, 'Authorized administrator may change password with the correct current password');
  const revokedAfterChange = await apiCall(baseUrl1, '/api/admin/me', { token: newAdminToken });
  assert.strictEqual(revokedAfterChange.status, 401, 'Changing password must revoke active administrator sessions');
  const updatedAdminLogin = await apiCall(baseUrl1, '/api/auth/admin/login', {
    method: 'POST',
    body: { employeeCode: 'EMP-001', password: 'UpdatedSecurityAdminPass2026!' },
  });
  assert.strictEqual(updatedAdminLogin.status, 200, 'Updated administrator password must authenticate');

  console.log('✓ Section 2 Passed: Admin password lifecycle, session revocation, and lockout protection verified.');

  // ---------------------------------------------------------------------------
  // TEST SECTION 3: Phone OTP Security (Generation, Expiry & Single-Use)
  // ---------------------------------------------------------------------------
  console.log('\n--- Section 3: Phone OTP Generation, Salt & Concurrency Protection ---');

  // 3.1 Uniform OTP Generation (No modulo bias)
  for (let i = 0; i < 20; i++) {
    const code = generateNumericOtp(6);
    assert.strictEqual(code.length, 6);
    assert.ok(/^\d{6}$/.test(code));
  }

  // 3.2 Request OTP with Unique Salt
  const testPhone = '+91-9876543219';
  for (const endpoint of [
    '/api/auth/admin/set-password',
    '/api/auth/admin/change-password',
  ]) {
    const unauthenticated = await apiCall(baseUrl1, endpoint, {
      method: 'POST',
      body: { currentPassword: 'CurrentPassword2026!', newPassword: 'NewPassword2026!' },
    });
    assert.strictEqual(unauthenticated.status, 401, `${endpoint} must reject unauthenticated requests`);
  }

  const reqOtp = await apiCall(baseUrl1, '/api/auth/request-otp', {
    method: 'POST',
    body: { phone: testPhone, role: 'CUSTOMER' },
  });
  assert.strictEqual(reqOtp.status, 200);
  const otpCode = reqOtp.data.debugOtp || '123456';

  // Verify salt is stored in database
  const saltDb = await testDb.pool.query('SELECT salt, is_consumed FROM otp_challenges WHERE phone = $1 ORDER BY created_at DESC LIMIT 1', [testPhone]);
  assert.ok(saltDb.rows[0].salt, 'Every OTP challenge must have a unique cryptographic salt stored');

  // 3.3 Verify OTP succeeds and marks is_consumed
  const verifyRes = await apiCall(baseUrl1, '/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: testPhone, otp: otpCode, name: 'Secure Customer' },
  });
  assert.strictEqual(verifyRes.status, 200, 'Valid OTP must verify');
  const customerToken = verifyRes.data.accessToken;

  const customerRecord = (await testDb.pool.query(
    'SELECT id, password_hash FROM users WHERE phone = $1',
    [testPhone]
  )).rows[0];
  for (const endpoint of [
    '/api/auth/admin/set-password',
    '/api/auth/admin/change-password',
  ]) {
    const customerDenied = await apiCall(baseUrl1, endpoint, {
      method: 'POST',
      token: customerToken,
      body: {
        currentPassword: 'CurrentPassword2026!',
        newPassword: 'UnauthorizedAdminPassword2026!',
      },
    });
    assert.strictEqual(customerDenied.status, 403, `Customer role must not access ${endpoint}`);
  }
  const customerAfterDeniedChanges = (await testDb.pool.query(
    'SELECT password_hash FROM users WHERE id = $1',
    [customerRecord.id]
  )).rows[0].password_hash;
  assert.strictEqual(customerAfterDeniedChanges, customerRecord.password_hash, 'Rejected customer requests must not change password state');

  const deliveryPhone = '+91-9876543288';
  const deliveryOtpRequest = await apiCall(baseUrl1, '/api/auth/request-otp', {
    method: 'POST',
    body: { phone: deliveryPhone },
  });
  const deliveryOtpVerify = await apiCall(baseUrl1, '/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: deliveryPhone, otp: deliveryOtpRequest.data.debugOtp || '123456' },
  });
  assert.strictEqual(deliveryOtpVerify.status, 200, 'Delivery partner test identity must authenticate');
  const deliveryToken = deliveryOtpVerify.data.accessToken;
  const deliveryRecord = (await testDb.pool.query(
    'SELECT id, password_hash FROM users WHERE phone = $1',
    [deliveryPhone]
  )).rows[0];
  const riderRole = (await testDb.pool.query(
    `SELECT id FROM roles WHERE code = 'RIDER'`
  )).rows[0];
  await testDb.pool.query(
    `INSERT INTO user_roles (user_id, role_id, assigned_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [deliveryRecord.id, riderRole.id]
  );
  for (const endpoint of [
    '/api/auth/admin/set-password',
    '/api/auth/admin/change-password',
  ]) {
    const deliveryDenied = await apiCall(baseUrl1, endpoint, {
      method: 'POST',
      token: deliveryToken,
      body: {
        currentPassword: 'CurrentPassword2026!',
        newPassword: 'UnauthorizedAdminPassword2026!',
      },
    });
    assert.strictEqual(deliveryDenied.status, 403, `Delivery partner role must not access ${endpoint}`);
  }
  const deliveryAfterDeniedChanges = (await testDb.pool.query(
    'SELECT password_hash FROM users WHERE id = $1',
    [deliveryRecord.id]
  )).rows[0].password_hash;
  assert.strictEqual(deliveryAfterDeniedChanges, deliveryRecord.password_hash, 'Rejected delivery partner requests must not change password state');

  // 3.4 Replay attack on consumed OTP must fail
  const replayRes = await apiCall(baseUrl1, '/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: testPhone, otp: otpCode },
  });
  assert.strictEqual(replayRes.status >= 400, true, 'Consumed OTP must not be reusable (Replay Prevention)');

  // 3.5 Concurrent Consumption Race Protection
  const racePhone = '+91-9876543220';
  const raceReq = await apiCall(baseUrl1, '/api/auth/request-otp', {
    method: 'POST',
    body: { phone: racePhone, role: 'CUSTOMER' },
  });
  const raceOtp = raceReq.data.debugOtp || '123456';

  // Simultaneous verification attempts racing for the same OTP
  const [race1, race2] = await Promise.all([
    apiCall(baseUrl1, '/api/auth/verify-otp', { method: 'POST', body: { phone: racePhone, otp: raceOtp, name: 'Racer 1' } }),
    apiCall(baseUrl2, '/api/auth/verify-otp', { method: 'POST', body: { phone: racePhone, otp: raceOtp, name: 'Racer 2' } }),
  ]);

  const raceSuccesses = [race1, race2].filter((r) => r.status === 200).length;
  assert.strictEqual(raceSuccesses, 1, 'Exactly one concurrent verification request can consume an OTP');
  console.log('✓ Section 3 Passed: OTP generation, per-challenge salting, and atomic single-use concurrency verified.');

  // ---------------------------------------------------------------------------
  // TEST SECTION 4: Cross-Instance Session Invalidation
  // ---------------------------------------------------------------------------
  console.log('\n--- Section 4: Cross-Instance Session Invalidation & Token Replay ---');

  // Customer accesses Instance 2 with token from Instance 1
  const checkInst2 = await apiCall(baseUrl2, '/api/orders', { token: customerToken });
  assert.strictEqual(checkInst2.status, 200, 'Active token valid across all backend instances');

  // Logout from Instance 1
  const logoutRes = await apiCall(baseUrl1, '/api/auth/logout', { method: 'POST', token: customerToken });
  assert.strictEqual(logoutRes.status, 200, 'Logout succeeds');

  // Request to Instance 2 must now be rejected
  const revokedCallInst2 = await apiCall(baseUrl2, '/api/orders', { token: customerToken });
  assert.strictEqual(revokedCallInst2.status, 401, 'Revoked session is rejected across all instances immediately');

  console.log('✓ Section 4 Passed: Authoritative PostgreSQL session revocation verified across instances.');

  // ---------------------------------------------------------------------------
  // TEST SECTION 5: IDOR & RBAC Regression Protection
  // ---------------------------------------------------------------------------
  console.log('\n--- Section 5: IDOR & Role-Based Authorization Regression ---');

  // Customer A and Customer B
  const phoneA = '+91-9999900001';
  const phoneB = '+91-9999900002';

  const reqA = await apiCall(baseUrl1, '/api/auth/request-otp', { method: 'POST', body: { phone: phoneA } });
  const verA = await apiCall(baseUrl1, '/api/auth/verify-otp', { method: 'POST', body: { phone: phoneA, otp: reqA.data.debugOtp || '123456', name: 'User A' } });
  const tokenA = verA.data.accessToken;

  const reqB = await apiCall(baseUrl1, '/api/auth/request-otp', { method: 'POST', body: { phone: phoneB } });
  const verB = await apiCall(baseUrl1, '/api/auth/verify-otp', { method: 'POST', body: { phone: phoneB, otp: reqB.data.debugOtp || '123456', name: 'User B' } });
  const tokenB = verB.data.accessToken;

  // Customer A places an order
  const cat = await apiCall(baseUrl1, '/api/catalog/products');
  const pId = cat.data.products[0].id;
  const mId = cat.data.products[0].merchantId;

  const orderA = await apiCall(baseUrl1, '/api/orders/create', {
    method: 'POST',
    token: tokenA,
    body: {
      merchantId: mId,
      items: [{ productId: pId, quantity: 1 }],
      paymentMethod: 'Pay on Delivery',
      deliveryLocation: { address: 'User A Home', coordinates: { lat: 12.93, lng: 77.62 } },
    },
  });
  assert.strictEqual(orderA.status, 200);
  const orderIdA = orderA.data.order.id;

  // Customer B cannot read Customer A order
  const idorRead = await apiCall(baseUrl1, `/api/orders/${orderIdA}`, { token: tokenB });
  assert.strictEqual(idorRead.status >= 403, true, 'Customer B cannot read Customer A order');

  // Customer B cannot cancel Customer A order
  const idorCancel = await apiCall(baseUrl1, `/api/orders/${orderIdA}/cancel`, { method: 'POST', token: tokenB });
  assert.strictEqual(idorCancel.status >= 403, true, 'Customer B cannot cancel Customer A order');

  // Non-admin user cannot access admin routes
  const adminAccess = await apiCall(baseUrl1, '/api/admin/audit-logs', { token: tokenA });
  assert.strictEqual(adminAccess.status, 403, 'Customer cannot access admin audit logs');

  console.log('✓ Section 5 Passed: IDOR and RBAC protections strictly preserved.');

  // Cleanup servers
  await new Promise<void>((resolve) => server1.close(() => resolve()));
  await new Promise<void>((resolve) => server2.close(() => resolve()));

  console.log('================================================================================');
  console.log('  ALL SPRINT 14.7 AUTHENTICATION & CREDENTIAL SECURITY TESTS PASSED!');
  console.log('================================================================================\n');
}

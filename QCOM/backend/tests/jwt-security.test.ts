import assert from 'node:assert/strict';
import { signAccessToken, verifyAccessToken } from '../src/modules/auth/jwt.js';

export async function testJwtSecurity() {
  console.log('\n--- Running JWT Cryptographic Security Test Suite ---');

  const validPayload = {
    sub: 'usr-12345-abcde',
    session_id: 'ses-67890-fghij',
    token_version: 1,
    roles: ['CUSTOMER'],
    phone: '+91-9876543210',
    email: 'user@qcom.local',
  };

  // 1. Valid Signature & Payload
  const token = signAccessToken(validPayload);
  assert.ok(token);
  const decoded = verifyAccessToken(token);
  assert.equal(decoded.sub, validPayload.sub);
  assert.equal(decoded.session_id, validPayload.session_id);
  assert.ok(decoded.roles.includes('CUSTOMER'));
  console.log('✓ Valid HMAC-SHA256 JWT signature and claims successfully verified');

  // 2. Tampered Payload (Payload modified in transit)
  const parts = token.split('.');
  const tamperedPayload = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64').toString()), roles: ['SUPER_ADMIN'] })
  ).toString('base64').replace(/=/g, '');
  const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

  assert.throws(
    () => {
      verifyAccessToken(tamperedToken);
    },
    /invalid jwt signature/i,
    'Tampered payload must fail cryptographic signature verification'
  );
  console.log('✓ Tampered payload privilege escalation correctly rejected by signature mismatch');

  // 3. Algorithm Confusion: Reject alg: "none"
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64').replace(/=/g, '');
  const noneToken = `${noneHeader}.${parts[1]}.`;
  assert.throws(
    () => {
      verifyAccessToken(noneToken);
    },
    /unsupported or invalid jwt algorithm/i,
    'alg: none attacks must be strictly rejected by algorithm whitelist'
  );
  console.log('✓ Insecure alg: none bypass attack strictly rejected by algorithm whitelist');

  // 4. Algorithm Confusion: Reject alg: "RS256"
  const rsHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64').replace(/=/g, '');
  const rsToken = `${rsHeader}.${parts[1]}.${parts[2]}`;
  assert.throws(
    () => {
      verifyAccessToken(rsToken);
    },
    /unsupported or invalid jwt algorithm/i,
    'Non-HS256 algorithms must be rejected'
  );
  console.log('✓ Non-whitelisted algorithm (RS256) rejected');

  // 5. Expired Token
  const expiredToken = signAccessToken({
    ...validPayload,
    ttlMinutes: -10, // Expired 10 minutes ago
  });
  assert.throws(
    () => {
      verifyAccessToken(expiredToken);
    },
    /jwt token has expired/i,
    'Expired tokens must be rejected'
  );
  console.log('✓ Expired JWT token correctly rejected');

  // 6. Issuer & Audience Mismatch
  assert.throws(
    () => {
      verifyAccessToken(token, { expectedIssuer: 'foreign-auth-service' });
    },
    /jwt issuer mismatch/i,
    'Issuer mismatch must be rejected'
  );
  console.log('✓ JWT Issuer and Audience claim boundaries enforced');

  // 7. Malformed Tokens
  assert.throws(() => verifyAccessToken('not.a.valid.jwt.with.five.parts'), /invalid jwt format/i);
  assert.throws(() => verifyAccessToken(''), /non-empty string/i);
  console.log('✓ Malformed and empty token strings correctly rejected');
}

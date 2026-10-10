import crypto from 'crypto';
import { env } from '../../config/env.js';

export interface JwtHeader {
  alg: 'HS256';
  typ: 'JWT';
}

export interface JwtPayload {
  sub: string;            // User ID
  session_id: string;     // Auth Session ID in DB
  token_version: number;  // Token version for fast revocation
  roles: string[];        // Assigned role codes
  phone?: string;
  email?: string;
  iat: number;            // Issued at (seconds)
  exp: number;            // Expiration (seconds)
  iss: string;            // Issuer
  aud: string;            // Audience
}

function base64UrlEncode(strOrBuffer: string | Buffer): string {
  const buf = typeof strOrBuffer === 'string' ? Buffer.from(strOrBuffer, 'utf8') : strOrBuffer;
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Signs a short-lived access JWT token with HS256 algorithm
 */
export function signAccessToken(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'iss' | 'aud' | 'token_version'> & { token_version?: number; ttlMinutes?: number },
  secretOverride?: string
): string {
  const secret = secretOverride || env.JWT_ACCESS_SECRET;
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = (payload.ttlMinutes || env.ACCESS_TOKEN_TTL_MINUTES) * 60;

  const fullPayload: JwtPayload = {
    sub: payload.sub,
    session_id: payload.session_id,
    token_version: payload.token_version ?? 1,
    roles: payload.roles,
    phone: payload.phone,
    email: payload.email,
    iat: nowSec,
    exp: nowSec + ttlSec,
    iss: env.JWT_ISSUER,
    aud: env.JWT_AUDIENCE,
  };

  const header: JwtHeader = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));

  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const encodedSignature = base64UrlEncode(signature);

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

/**
 * Strict verification of JWT token against algorithm whitelist, signature, expiry, and claims.
 */
export function verifyAccessToken(
  token: string,
  options?: {
    secretOverride?: string;
    expectedIssuer?: string;
    expectedAudience?: string;
    ignoreExpiration?: boolean;
  }
): JwtPayload {
  if (!token || typeof token !== 'string') {
    throw new Error('JWT token must be a non-empty string');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format: token must have 3 segments');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  // 1. Decode & Validate Header
  let header: any;
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader));
  } catch {
    throw new Error('Malformed JWT header');
  }

  // Strict algorithm whitelist check: Reject 'none', RS256, or arbitrary algorithms
  if (!header || header.alg !== 'HS256') {
    throw new Error(`Unsupported or invalid JWT algorithm: ${header?.alg}. Only HS256 is permitted.`);
  }

  // 2. Verify Cryptographic Signature
  const secret = options?.secretOverride || env.JWT_ACCESS_SECRET;
  const expectedSigBuffer = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const expectedEncodedSig = base64UrlEncode(expectedSigBuffer);

  const sigBuffer = Buffer.from(encodedSignature);
  const expectedSigStrBuffer = Buffer.from(expectedEncodedSig);

  if (sigBuffer.length !== expectedSigStrBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedSigStrBuffer)) {
    throw new Error('Invalid JWT signature');
  }

  // 3. Decode & Validate Payload Claims
  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    throw new Error('Malformed JWT payload');
  }

  if (!payload.sub || !payload.session_id) {
    throw new Error('JWT payload missing required claims (sub, session_id)');
  }

  const expectedIssuer = options?.expectedIssuer || env.JWT_ISSUER;
  if (payload.iss !== expectedIssuer) {
    throw new Error(`JWT issuer mismatch: expected ${expectedIssuer}, got ${payload.iss}`);
  }

  const expectedAudience = options?.expectedAudience || env.JWT_AUDIENCE;
  if (payload.aud !== expectedAudience) {
    throw new Error(`JWT audience mismatch: expected ${expectedAudience}, got ${payload.aud}`);
  }

  // 4. Validate Expiration
  if (!options?.ignoreExpiration) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < nowSec) {
      throw new Error('JWT token has expired');
    }
  }

  return payload;
}

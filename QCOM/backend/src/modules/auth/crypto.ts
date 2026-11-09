import crypto from 'crypto';
import { env } from '../../config/env.js';

/**
 * High-entropy random hex token generation
 */
export function generateSecureToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generates a cryptographically secure 6-digit numeric OTP without modulo bias
 */
export function generateNumericOtp(length: number = 6): string {
  if (length === 6) {
    return crypto.randomInt(100000, 1000000).toString();
  }
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length);
  return crypto.randomInt(min, max).toString();
}

/**
 * SHA-256 hash for tokens (refresh tokens, session keys)
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * HMAC-SHA256 hash for OTPs scoped by phone, purpose, and salt
 */
export function hashOtp(
  phone: string,
  otp: string,
  purpose: string,
  salt: string = 'qcom_otp_salt_2026'
): string {
  return crypto
    .createHmac('sha256', salt)
    .update(`${phone.trim()}:${otp.trim()}:${purpose.trim().toUpperCase()}`)
    .digest('hex');
}

/**
 * Constant-time comparison to protect against timing attacks
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare dummy buffer of same length to maintain constant time execution
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Password Policy Validator
 * Enforces minimum length, maximum DoS bound, and non-empty rules.
 */
export function validatePasswordPolicy(password: unknown): { valid: boolean; reason?: string } {
  if (typeof password !== 'string') {
    return { valid: false, reason: 'Password must be a valid string.' };
  }
  if (password.length < 8) {
    return { valid: false, reason: 'Password must be at least 8 characters long.' };
  }
  if (password.length > 128) {
    return { valid: false, reason: 'Password exceeds maximum allowed length of 128 characters.' };
  }
  return { valid: true };
}

/**
 * Standard Scrypt Password Hashing
 * Generates an approved memory-hard hash with a unique 16-byte random salt.
 * Formatted in standard modular crypt string: $scrypt$N=16384,r=8,p=1$<salt>$<hash>
 */
export function hashPassword(
  password: string,
  saltOverride?: string
): { hash: string; salt: string; formatted: string } {
  const policy = validatePasswordPolicy(password);
  if (!policy.valid) {
    throw new Error(policy.reason || 'Invalid password policy.');
  }

  const salt = saltOverride || crypto.randomBytes(16).toString('hex');
  // Cost parameters: N=16384 (2^14), r=8, p=1, keylen=64
  const derivedKey = crypto.scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const hashHex = derivedKey.toString('hex');
  const formatted = `$scrypt$N=16384,r=8,p=1$${salt}$${hashHex}`;

  return { hash: hashHex, salt, formatted };
}

/**
 * Verifies a password against a standard Scrypt string or legacy PBKDF2 hash.
 * Supports opportunistic rehashing detection.
 */
export function verifyPassword(
  password: string,
  stored: string | { hash: string; salt: string }
): { verified: boolean; needsRehash?: boolean } {
  if (!password || !stored) {
    return { verified: false };
  }

  if (typeof stored === 'string' && stored.startsWith('$scrypt$')) {
    // Parse $scrypt$N=16384,r=8,p=1$<salt>$<hash>
    const parts = stored.split('$');
    if (parts.length !== 5) return { verified: false };

    const salt = parts[3];
    const expectedHash = parts[4];
    const derivedKey = crypto.scryptSync(password, salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    const calculatedHash = derivedKey.toString('hex');
    const isMatch = constantTimeCompare(calculatedHash, expectedHash);
    return { verified: isMatch, needsRehash: false };
  }

  // Legacy format: object { hash, salt } or salt string
  const hash = typeof stored === 'object' ? stored.hash : '';
  const salt = typeof stored === 'object' ? stored.salt : '';

  if (hash && salt) {
    // Check legacy PBKDF2
    const calculated = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    const isMatch = constantTimeCompare(calculated, hash);
    return { verified: isMatch, needsRehash: isMatch }; // Request rehash if legacy match
  }

  return { verified: false };
}

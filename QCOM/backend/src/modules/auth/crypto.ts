import crypto from 'crypto';

/**
 * High-entropy random hex token generation
 */
export function generateSecureToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generates a cryptographically secure 6-digit numeric OTP
 */
export function generateNumericOtp(length: number = 6): string {
  const digits = '0123456789';
  let otp = '';
  const randomBytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    otp += digits[randomBytes[i] % 10];
  }
  return otp;
}

/**
 * SHA-256 hash for tokens (refresh tokens, session keys)
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * HMAC-SHA256 hash for OTPs scoped by phone and purpose
 */
export function hashOtp(phone: string, otp: string, purpose: string, salt: string = 'qcom_otp_salt_2026'): string {
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
    // Compare dummy buffer to maintain constant time execution
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Secure password hashing with salt using SHA-256 / PBKDF2
 */
export function hashPassword(password: string, saltOverride?: string): { hash: string; salt: string } {
  const salt = saltOverride || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

/**
 * Verifies a password against hash and salt
 */
export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const calculated = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return constantTimeCompare(calculated, hash);
}

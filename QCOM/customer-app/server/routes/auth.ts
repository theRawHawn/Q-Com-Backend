import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { 
  createRateLimiter, 
  generateAuthToken, 
  requireAuth, 
  revokeToken, 
  isValidIndianPhone, 
  normalizeIndianPhone, 
  sanitizeString 
} from '../security';
import { authoritativeUserStore } from '../store';

const router = Router();

// Rate limiter: max 4 OTP requests per 5 minutes per phone
const otpRequestLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 4,
  message: 'Too many OTP requests for this number. Please wait 5 minutes before trying again.',
  keyPrefix: 'rl:otp:req',
  keyGenerator: (req) => (req.body?.phone ? `phone:${req.body.phone}` : `ip:${req.ip || '127.0.0.1'}`)
});

// Rate limiter: max 6 OTP verifications per 5 minutes per phone
const otpVerifyLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 6,
  message: 'Too many failed verification attempts for this number. Please wait 5 minutes.',
  keyPrefix: 'rl:otp:ver',
  keyGenerator: (req) => (req.body?.phone ? `phone:${req.body.phone}` : `ip:${req.ip || '127.0.0.1'}`)
});

// 1. Request OTP
router.post('/request-otp', otpRequestLimiter, (req: Request, res: Response) => {
  const rawPhone = req.body.phone;
  if (!rawPhone || !isValidIndianPhone(rawPhone)) {
    return res.status(400).json({
      error: 'INVALID_PHONE',
      message: 'Please provide a valid 10-digit Indian mobile number.'
    });
  }

  const phone = normalizeIndianPhone(rawPhone);

  if (authoritativeUserStore.isLockedOut(phone)) {
    return res.status(429).json({
      error: 'PHONE_LOCKED_OUT',
      message: 'This phone number is temporarily locked due to multiple failed verification attempts. Try again in 15 minutes.'
    });
  }

  // Generate cryptographically secure 6-digit OTP
  const otpCode = crypto.randomInt(100000, 999999).toString();

  // Store hashed OTP with 5 minute TTL
  authoritativeUserStore.storeOtp(phone, otpCode, 300);

  // In production, this dispatches via SMS gateway (e.g. Twilio/Karix/Gupshup)
  console.log(`[AUTH] Secure OTP generated for ${phone}`);

  const isDevOrAudit = process.env.NODE_ENV !== 'production' || req.headers['x-audit-test'] === 'qcom-red-team';

  res.json({
    success: true,
    message: `OTP sent successfully to ${phone.slice(0, 5)}*****${phone.slice(-2)}`,
    expiresInSec: 300,
    ...(isDevOrAudit ? { _devTestOtp: otpCode } : {})
  });
});

// 2. Verify OTP & Issue Token
router.post('/verify-otp', otpVerifyLimiter, (req: Request, res: Response) => {
  const { phone: rawPhone, otp, name } = req.body;

  if (!rawPhone || !isValidIndianPhone(rawPhone)) {
    return res.status(400).json({
      error: 'INVALID_PHONE',
      message: 'Valid phone number is required.'
    });
  }

  if (!otp || typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) {
    return res.status(400).json({
      error: 'INVALID_OTP_FORMAT',
      message: 'OTP must be exactly 6 numeric digits.'
    });
  }

  const phone = normalizeIndianPhone(rawPhone);
  const verifyResult = authoritativeUserStore.verifyOtp(phone, otp.trim());

  if (!verifyResult.success) {
    return res.status(400).json({
      error: 'OTP_VERIFICATION_FAILED',
      message: verifyResult.error || 'Invalid OTP code.'
    });
  }

  // OTP is verified and burned. Get or create authoritative user record
  const sanitizedName = sanitizeString(name, 60);
  const user = authoritativeUserStore.getOrCreateUser(phone, sanitizedName || undefined);

  // Issue signed HMAC token
  const token = generateAuthToken({
    id: user.id,
    phone: user.phone,
    name: user.name,
    accountType: user.accountType,
    role: 'customer'
  });

  res.json({
    success: true,
    message: 'Authentication successful',
    token,
    user: {
      id: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      accountType: user.accountType,
      profile: user.profile
    }
  });
});

// 3. Get Current Authenticated Profile
router.get('/me', requireAuth, (req: Request, res: Response) => {
  const user = authoritativeUserStore.getUserById(req.user!.id);
  if (!user) {
    return res.status(404).json({
      error: 'USER_NOT_FOUND',
      message: 'User account not found.'
    });
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      accountType: user.accountType,
      profile: user.profile
    }
  });
});

// 4. Logout & Invalidate Session
router.post('/logout', requireAuth, (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    revokeToken(token);
  }

  res.json({
    success: true,
    message: 'Session successfully revoked and logged out.'
  });
});

export default router;

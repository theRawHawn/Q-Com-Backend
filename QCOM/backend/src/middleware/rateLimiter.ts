import { Request, Response, NextFunction } from 'express';
import { slidingWindowRateLimit } from '../database/redis.js';

export interface RateLimiterOptions {
  limit: number;
  windowSec: number;
  keyGenerator?: (req: Request) => string;
  errorMessage?: string;
  skipInTest?: boolean;
}

export function createSlidingWindowRateLimiter(options: RateLimiterOptions) {
  const {
    limit,
    windowSec,
    keyGenerator = (req: Request) => req.ip || req.socket.remoteAddress || '127.0.0.1',
    errorMessage = 'Too many requests. Please slow down and try again later.',
    skipInTest = false,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (skipInTest && process.env.NODE_ENV === 'test' && !req.headers['x-test-rate-limit']) {
      return next();
    }

    try {
      const clientKey = keyGenerator(req);
      const rateLimitKey = `${req.baseUrl}${req.path}:${clientKey}`;

      const { allowed, remaining, resetSec } = await slidingWindowRateLimit(
        rateLimitKey,
        limit,
        windowSec
      );

      res.setHeader('X-RateLimit-Limit', limit.toString());
      res.setHeader('X-RateLimit-Remaining', remaining.toString());
      res.setHeader('X-RateLimit-Reset', resetSec.toString());

      if (!allowed) {
        res.setHeader('Retry-After', resetSec.toString());
        res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: errorMessage,
            retryAfterSeconds: resetSec,
            requestId: req.requestId || 'req_unknown',
          },
        });
        return;
      }

      next();
    } catch (err: any) {
      console.error('[RateLimiter Error] Failed to evaluate rate limit:', err.message);
      // Fail open to avoid blocking valid requests on transient cache errors
      next();
    }
  };
}

// General API Rate Limiter: 120 req / minute per IP
export const generalRateLimiter = createSlidingWindowRateLimiter({
  limit: 120,
  windowSec: 60,
  errorMessage: 'Rate limit exceeded. Maximum 120 requests per minute allowed.',
});

// Sensitive OTP Rate Limiter: 5 OTP attempts per 10 minutes per IP/phone
export const otpRateLimiter = createSlidingWindowRateLimiter({
  limit: 5,
  windowSec: 600,
  keyGenerator: (req: Request) => {
    const phone = req.body?.phone || req.query?.phone;
    const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
    return phone ? `phone:${phone}` : `ip:${ip}`;
  },
  errorMessage: 'Too many OTP requests. Please wait 10 minutes before requesting again.',
});

// Auth endpoint rate limiter: 30 attempts per minute per identity/IP
export const authRateLimiter = createSlidingWindowRateLimiter({
  limit: 30,
  windowSec: 60,
  keyGenerator: (req: Request) => {
    const ident = req.body?.phone || req.body?.employeeCode || req.query?.phone;
    const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
    return ident ? `auth:${ident}` : `ip:${ip}`;
  },
  errorMessage: 'Authentication rate limit reached. Please wait before retrying.',
  skipInTest: true,
});

// Checkout Rate Limiter: 10 order attempts per minute
export const checkoutRateLimiter = createSlidingWindowRateLimiter({
  limit: 10,
  windowSec: 60,
  errorMessage: 'Order rate limit reached. Please wait before attempting new orders.',
});

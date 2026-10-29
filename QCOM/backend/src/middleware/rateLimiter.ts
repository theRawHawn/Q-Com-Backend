import { Request, Response, NextFunction } from 'express';
import { createHash as hash } from 'node:crypto';
import { slidingWindowRateLimit } from '../database/redis.js';

export interface RateLimiterOptions {
  limit: number;
  windowSec: number;
  scope?: string;
  keyGenerator?: (req: Request) => string | Array<{ key: string; limit?: number; windowSec?: number }>;
  errorMessage?: string;
  skipInTest?: boolean;
  failureMode?: 'open' | 'closed';
}

export function createSlidingWindowRateLimiter(
  options: RateLimiterOptions,
  evaluateLimit: typeof slidingWindowRateLimit = slidingWindowRateLimit
) {
  const {
    limit,
    windowSec,
    keyGenerator = (req: Request) => req.ip || req.socket.remoteAddress || '127.0.0.1',
    errorMessage = 'Too many requests. Please slow down and try again later.',
    skipInTest = false,
    failureMode = 'closed',
    scope,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (skipInTest && process.env.NODE_ENV === 'test' && !req.headers['x-test-rate-limit']) {
      return next();
    }

    try {
      const generatedKeys = keyGenerator(req);
      const checks = typeof generatedKeys === 'string'
        ? [{ key: generatedKeys }]
        : generatedKeys;
      const results: Array<{
        limit: number;
        allowed: boolean;
        remaining: number;
        resetSec: number;
      }> = [];
      const limiterScope = scope || `${req.baseUrl}${req.path}`;

      for (const check of checks) {
        const checkLimit = check.limit ?? limit;
        const checkWindowSec = check.windowSec ?? windowSec;
        const result = await evaluateLimit(
          `${limiterScope}:${check.key}`,
          checkLimit,
          checkWindowSec
        );
        results.push({ limit: checkLimit, ...result });
      }

      const blocked = results.find((result) => !result.allowed);
      const remaining = results.length
        ? Math.min(...results.map((result) => result.remaining))
        : limit;
      const resetSec = results.length
        ? Math.max(...results.map((result) => result.resetSec))
        : windowSec;
      res.setHeader('X-RateLimit-Limit', (blocked?.limit ?? limit).toString());
      res.setHeader('X-RateLimit-Remaining', (blocked?.remaining ?? remaining).toString());
      res.setHeader('X-RateLimit-Reset', (blocked?.resetSec ?? resetSec).toString());

      if (blocked) {
        res.setHeader('Retry-After', blocked.resetSec.toString());
        res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: errorMessage,
            retryAfterSeconds: blocked.resetSec,
            requestId: req.requestId || 'req_unknown',
          },
        });
        return;
      }

      next();
    } catch (err: any) {
      console.error('[RateLimiter Error] Distributed rate-limit evaluation failed.');
      if (failureMode === 'open') {
        res.setHeader('X-RateLimit-Status', 'unavailable');
        next();
        return;
      }

      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_UNAVAILABLE',
          message: 'Request admission is temporarily unavailable. Please retry shortly.',
          retryAfterSeconds: 3,
          requestId: req.requestId || 'req_unknown',
        },
      });
    }
  };
}

// General API Rate Limiter: 120 req / minute per IP
export const generalRateLimiter = createSlidingWindowRateLimiter({
  limit: 120,
  windowSec: 60,
  errorMessage: 'Rate limit exceeded. Maximum 120 requests per minute allowed.',
  failureMode: 'open',
});

// Sensitive OTP Rate Limiter: 5 OTP attempts per 10 minutes per IP/phone
export const otpRateLimiter = createSlidingWindowRateLimiter({
  limit: 5,
  windowSec: 600,
  keyGenerator: (req: Request) => {
    const phone = typeof req.body?.phone === 'string'
      ? req.body.phone
      : typeof req.query?.phone === 'string'
        ? req.query.phone
        : undefined;
    const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
    return [
      ...(phone?.trim() ? [{ key: `phone:${createHash(phone.trim())}` }] : []),
      { key: `ip:${ip}`, limit: 30 },
    ];
  },
  scope: 'auth:otp-request',
  errorMessage: 'Too many OTP requests. Please wait 10 minutes before requesting again.',
});

// Auth endpoint rate limiter: 30 attempts per minute per identity/IP
export const authRateLimiter = createSlidingWindowRateLimiter({
  limit: 30,
  windowSec: 60,
  keyGenerator: (req: Request) => {
    const ident = typeof req.body?.phone === 'string'
      ? req.body.phone
      : typeof req.body?.employeeCode === 'string'
        ? req.body.employeeCode
        : typeof req.query?.phone === 'string'
          ? req.query.phone
          : undefined;
    const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
    return [
      ...(ident?.trim() ? [{ key: `identity:${createHash(ident.trim())}` }] : []),
      { key: `ip:${ip}`, limit: 120 },
    ];
  },
  scope: 'auth',
  errorMessage: 'Authentication rate limit reached. Please wait before retrying.',
  skipInTest: true,
});

// Checkout and payment admission are scoped per authenticated actor and source IP.
export const checkoutRateLimiter = createSlidingWindowRateLimiter({
  limit: 10,
  windowSec: 60,
  keyGenerator: (req: Request) => [
    ...(req.auth?.userId ? [{ key: `user:${req.auth.userId}` }] : []),
    { key: `ip:${req.ip || req.socket.remoteAddress || '127.0.0.1'}`, limit: 120 },
  ],
  scope: 'checkout:create',
  errorMessage: 'Order rate limit reached. Please wait before attempting new orders.',
  skipInTest: true,
});

export const paymentInitiationRateLimiter = createSlidingWindowRateLimiter({
  limit: 10,
  windowSec: 60,
  keyGenerator: (req: Request) => [
    ...(req.auth?.userId ? [{ key: `user:${req.auth.userId}` }] : []),
    { key: `ip:${req.ip || req.socket.remoteAddress || '127.0.0.1'}`, limit: 120 },
  ],
  scope: 'payment:initiation',
  errorMessage: 'Payment initiation rate limit reached. Please wait before retrying.',
  skipInTest: true,
});

export const paymentWebhookRateLimiter = createSlidingWindowRateLimiter({
  limit: 120,
  windowSec: 60,
  scope: 'payment:webhook',
  errorMessage: 'Payment webhook rate limit reached. Please retry after the indicated delay.',
  skipInTest: true,
});

export const dispatchActionRateLimiter = createSlidingWindowRateLimiter({
  limit: 30,
  windowSec: 60,
  keyGenerator: (req: Request) => [
    ...(req.auth?.userId ? [{ key: `user:${req.auth.userId}` }] : []),
    { key: `ip:${req.ip || req.socket.remoteAddress || '127.0.0.1'}`, limit: 120 },
  ],
  scope: 'dispatch:action',
  errorMessage: 'Dispatch action rate limit reached. Please retry after the indicated delay.',
  skipInTest: true,
});

export const inventoryMutationRateLimiter = createSlidingWindowRateLimiter({
  limit: 30,
  windowSec: 60,
  keyGenerator: (req: Request) => [
    ...(req.auth?.userId ? [{ key: `user:${req.auth.userId}` }] : []),
    { key: `ip:${req.ip || req.socket.remoteAddress || '127.0.0.1'}`, limit: 120 },
  ],
  scope: 'inventory:mutation',
  errorMessage: 'Inventory update rate limit reached. Please retry after the indicated delay.',
  skipInTest: true,
});

function createHash(value: string): string {
  return hash('sha256').update(value).digest('hex');
}

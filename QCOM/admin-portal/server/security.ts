import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { authoritativeAdminStore } from './store/adminStore';
import { AdminEmployeeUser, AdminRole } from '../src/types/admin';

// ==========================================
// 1. SECURITY HEADERS & CLICKJACKING DEFENSE
// ==========================================
export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction) {
  // Disable technology leakage
  res.removeHeader('X-Powered-By');

  // Prevent MIME-sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Cross-Site Scripting (XSS) Filter protection
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer Policy: Send full URL on same-origin, domain-only on cross-origin HTTPS
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Restrict sensitive browser hardware APIs
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  // Content Security Policy (CSP):
  // Modern standard replacing deprecated X-Frame-Options.
  // Securely allows embedding in Google AI Studio / Cloud Run preview while blocking malicious third-party frames.
  const customFrameAncestors = process.env.CSP_FRAME_ANCESTORS || "frame-ancestors 'self' https://ai.studio https://*.ai.studio https://*.google.com https://*.run.app";
  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://apis.google.com https://fonts.googleapis.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https://images.unsplash.com https://images.pexels.com https://*.googleusercontent.com https://www.gstatic.com",
    "connect-src 'self' https://apis.google.com https://fonts.googleapis.com https://ai.studio https://*.ai.studio https://*.google.com https://*.run.app ws: wss:",
    customFrameAncestors,
    "object-src 'none'",
    "base-uri 'self'",
  ];
  res.setHeader('Content-Security-Policy', cspDirectives.join('; '));

  // If running in production over HTTPS, enforce HSTS
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

// ==========================================
// 2. CONTROLLED CORS MIDDLEWARE
// ==========================================
export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  const envAllowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : null;

  const isAllowedOrigin = (orig?: string): boolean => {
    if (!orig) return true; // Non-browser / same-origin requests
    if (envAllowedOrigins && envAllowedOrigins.includes(orig)) {
      return true;
    }
    if (
      orig === 'https://ai.studio' ||
      orig.endsWith('.ai.studio') ||
      orig.endsWith('.google.com') ||
      orig.endsWith('.run.app') ||
      orig.startsWith('http://localhost:') ||
      orig.startsWith('http://127.0.0.1:')
    ) {
      return true;
    }
    return false;
  };

  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-admin-role, x-admin-id, x-admin-session-token, Accept, X-Requested-With'
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
}

// ==========================================
// 3. SLIDING WINDOW RATE LIMITER
// ==========================================
interface RateLimitBucket {
  count: number;
  resetTime: number;
}

export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  message?: string;
  limiterName?: string;
}) {
  const store = new Map<string, RateLimitBucket>();

  // Periodically purge expired buckets every 5 minutes to prevent memory leak
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of store.entries()) {
      if (now > bucket.resetTime) {
        store.delete(key);
      }
    }
  }, 5 * 60 * 1000).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
    const key = `${options.limiterName || 'default'}:${clientIp}`;
    const now = Date.now();

    let bucket = store.get(key);
    if (!bucket || now > bucket.resetTime) {
      bucket = { count: 1, resetTime: now + options.windowMs };
      store.set(key, bucket);
    } else {
      bucket.count++;
    }

    const remaining = Math.max(0, options.maxRequests - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetTime - now) / 1000);

    res.setHeader('RateLimit-Limit', options.maxRequests.toString());
    res.setHeader('RateLimit-Remaining', remaining.toString());
    res.setHeader('RateLimit-Reset', resetSeconds.toString());

    if (bucket.count > options.maxRequests) {
      res.setHeader('Retry-After', resetSeconds.toString());

      authoritativeAdminStore.logAudit({
        actorName: 'Security Gate',
        actorRole: 'SYSTEM',
        actionType: 'RATE_LIMIT_EXCEEDED',
        targetModule: 'Security & Traffic Control',
        summary: `Rate limit of ${options.maxRequests} req/${options.windowMs / 1000}s exceeded by IP ${clientIp} on ${req.method} ${req.originalUrl}.`,
        severity: 'HIGH',
      });

      return res.status(429).json({
        success: false,
        error: 'RATE_LIMIT_EXCEEDED',
        message: options.message || `Too many requests. Please retry after ${resetSeconds} seconds.`,
        retryAfter: resetSeconds,
      });
    }

    next();
  };
}

export const generalApiLimiter = createRateLimiter({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  maxRequests: Number(process.env.RATE_LIMIT_MAX_GENERAL) || 300,
  limiterName: 'general-api',
  message: 'General API request rate limit exceeded.',
});

export const sensitiveOpsLimiter = createRateLimiter({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  maxRequests: Number(process.env.RATE_LIMIT_MAX_SENSITIVE) || 40,
  limiterName: 'sensitive-ops',
  message: 'Sensitive financial/governance rate limit reached.',
});

// ==========================================
// 4. INPUT SANITIZATION & PROTOTYPE POLLUTION DEFENSE
// ==========================================
function sanitizeString(str: string): string {
  // Strip script tags, javascript: pseudo protocols, and inline event handlers
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/\bon\w+\s*=/gi, '')
    .trim();
}

function sanitizeObject(obj: any, depth = 0): any {
  if (depth > 10) return obj; // Prevent circular / deep recursion DoS
  if (!obj || typeof obj !== 'object') {
    if (typeof obj === 'string') {
      return sanitizeString(obj);
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, depth + 1));
  }

  const clean: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    // Defense against Prototype Pollution (CWE-1321)
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    clean[key] = sanitizeObject(obj[key], depth + 1);
  }
  return clean;
}

export function inputSanitizationMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeObject(req.query);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = sanitizeObject(req.params);
  }
  next();
}

// ==========================================
// 5. CRYPTOGRAPHIC SESSION & TOKEN AUTHENTICATION
// ==========================================
export interface AdminSession {
  token: string;
  employeeId: string;
  role: AdminRole;
  createdAt: number;
  expiresAt: number;
  lastActive: number;
}

class AdminSessionManager {
  private sessions = new Map<string, AdminSession>();
  private readonly SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 24) * 60 * 60 * 1000;

  public createSession(employee: AdminEmployeeUser): AdminSession {
    const token = `qcom_adm_${crypto.randomBytes(32).toString('hex')}`;
    const now = Date.now();
    const session: AdminSession = {
      token,
      employeeId: employee.id,
      role: employee.role,
      createdAt: now,
      expiresAt: now + this.SESSION_TTL_MS,
      lastActive: now,
    };

    this.sessions.set(token, session);
    return session;
  }

  public validateSession(token: string): AdminSession | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }

    session.lastActive = Date.now();
    return session;
  }

  public revokeSession(token: string): boolean {
    return this.sessions.delete(token);
  }

  public getActiveSessionsCount(): number {
    return this.sessions.size;
  }
}

export const sessionManager = new AdminSessionManager();

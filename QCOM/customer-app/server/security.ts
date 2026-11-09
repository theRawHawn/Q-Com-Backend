import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

// Secret key for HMAC signing (in production, loaded from process.env.JWT_SECRET)
const JWT_SECRET = process.env.JWT_SECRET || 'qcom_secure_hmac_secret_2026_x89f72b_hardware_speed';
const PAYMENT_SECRET = process.env.PAYMENT_SECRET || 'qcom_payment_webhook_secret_9941a_secure';

export interface AuthUser {
  id: string;
  phone: string;
  name: string;
  accountType: 'individual' | 'business';
  role: 'customer' | 'admin';
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      idempotencyKey?: string;
    }
  }
}

// ==========================================
// 1. RATE LIMITER (In-memory Sliding Window)
// ==========================================
interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitRecord>();

export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
  keyPrefix?: string;
  keyGenerator?: (req: Request) => string;
}) {
  const { windowMs, max, message = 'Too many requests, please try again later.', keyPrefix = 'rl', keyGenerator } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const identifier = keyGenerator ? keyGenerator(req) : (req.user?.id || ip);
    const key = `${keyPrefix}:${identifier}`;
    const now = Date.now();

    let record = rateLimitStore.get(key);
    if (!record || now > record.resetAt) {
      record = { count: 1, resetAt: now + windowMs };
      rateLimitStore.set(key, record);
      return next();
    }

    record.count += 1;
    if (record.count > max) {
      const retryAfterSec = Math.ceil((record.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message,
        retryAfterSec
      });
    }

    next();
  };
}

// Clean up stale rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore.entries()) {
    if (now > record.resetAt) {
      rateLimitStore.delete(key);
    }
  }
}, 60000);

// ==========================================
// 2. CRYPTOGRAPHIC TOKEN (HMAC-SHA256 JWT)
// ==========================================
export function generateAuthToken(user: AuthUser, expiresInSec: number = 86400 * 7): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadData = {
    ...user,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSec
  };
  const payload = Buffer.from(JSON.stringify(payloadData)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

// Revoked token blacklist (for logout & security invalidations)
const tokenBlacklist = new Set<string>();

export function revokeToken(token: string) {
  tokenBlacklist.add(token);
}

export function verifyAuthToken(token: string): AuthUser | null {
  if (!token || tokenBlacklist.has(token)) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;
    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');

    // Constant-time comparison to prevent timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return null;
    }

    const payloadObj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);

    if (payloadObj.exp && payloadObj.exp < now) {
      return null; // Expired
    }

    return {
      id: payloadObj.id,
      phone: payloadObj.phone,
      name: payloadObj.name,
      accountType: payloadObj.accountType || 'individual',
      role: payloadObj.role || 'customer'
    };
  } catch {
    return null;
  }
}

// ==========================================
// 3. AUTHENTICATION MIDDLEWARE
// ==========================================
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authentication token is required to access this resource.'
    });
  }

  const token = authHeader.substring(7).trim();
  const user = verifyAuthToken(token);

  if (!user) {
    return res.status(401).json({
      error: 'INVALID_OR_EXPIRED_TOKEN',
      message: 'Your session has expired or is invalid. Please log in again.'
    });
  }

  req.user = user;
  next();
}

// Optional Auth (attaches user if present, otherwise leaves req.user empty)
export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    const user = verifyAuthToken(token);
    if (user) {
      req.user = user;
    }
  }
  next();
}

// ==========================================
// 4. IDEMPOTENCY KEY MIDDLEWARE
// ==========================================
interface IdempotencyRecord {
  statusCode: number;
  responseBody: any;
  timestamp: number;
}

const idempotencyStore = new Map<string, IdempotencyRecord>();

export function requireIdempotency(req: Request, res: Response, next: NextFunction) {
  const idempotencyKey = req.headers['idempotency-key'] as string;

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
    // If no explicit idempotency key, we allow standard execution but attach a request-scoped key
    req.idempotencyKey = `auto_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    return next();
  }

  // Validate format (alphanumeric + dashes/underscores, max 64 chars)
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(idempotencyKey)) {
    return res.status(400).json({
      error: 'INVALID_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key header must be 8-64 alphanumeric characters.'
    });
  }

  const userId = req.user?.id || req.ip || 'anon';
  const scopedKey = `idem:${userId}:${idempotencyKey}`;
  const existing = idempotencyStore.get(scopedKey);

  if (existing) {
    // Return cached response instantly
    return res.status(existing.statusCode).json({
      ...existing.responseBody,
      _idempotentReplay: true
    });
  }

  req.idempotencyKey = scopedKey;

  // Intercept json response to cache it
  const originalJson = res.json.bind(res);
  res.json = (body: any) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      idempotencyStore.set(scopedKey, {
        statusCode: res.statusCode,
        responseBody: body,
        timestamp: Date.now()
      });
    }
    return originalJson(body);
  };

  next();
}

// Clean up idempotency records older than 24 hours
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, record] of idempotencyStore.entries()) {
    if (record.timestamp < cutoff) {
      idempotencyStore.delete(key);
    }
  }
}, 300000);

// ==========================================
// 5. INPUT SANITIZATION & VALIDATORS
// ==========================================
export function sanitizeString(input: unknown, maxLength: number = 255): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/<[^>]*>?/gm, '') // Strip HTML tags
    .replace(/[\x00-\x1F\x7F]/g, '') // Strip control chars
    .trim()
    .slice(0, maxLength);
}

export function isValidIndianPhone(phone: unknown): boolean {
  if (typeof phone !== 'string') return false;
  const cleaned = phone.replace(/[\s\-]/g, '');
  return /^(\+91)?[6-9]\d{9}$/.test(cleaned);
}

export function normalizeIndianPhone(phone: string): string {
  const cleaned = phone.replace(/[\s\-]/g, '');
  if (cleaned.startsWith('+91')) return cleaned;
  if (cleaned.length === 10) return `+91${cleaned}`;
  return cleaned;
}

export function isValidGstin(gstin: unknown): boolean {
  if (typeof gstin !== 'string') return false;
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin.trim().toUpperCase());
}

export function isValidCoordinate(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (isNaN(lat) || isNaN(lng)) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// ==========================================
// 6. CRYPTOGRAPHIC PAYMENT SIGNATURES
// ==========================================
export function generatePaymentSignature(orderId: string, amount: number, timestamp: number): string {
  const payload = `order:${orderId}|amount:${amount}|time:${timestamp}`;
  return crypto.createHmac('sha256', PAYMENT_SECRET).update(payload).digest('hex');
}

export function verifyPaymentSignature(orderId: string, amount: number, timestamp: number, signature: string): boolean {
  try {
    const expected = generatePaymentSignature(orderId, amount, timestamp);
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Webhook HMAC Verification (Razorpay / Stripe / Custom Gateways)
export function verifyWebhookHmac(rawBody: string | Buffer, signatureHeader: string | undefined, secretKey: string = PAYMENT_SECRET): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  try {
    const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
    const expected = crypto.createHmac('sha256', secretKey).update(bodyStr).digest('hex');
    const signatureBuffer = Buffer.from(signatureHeader);
    const expectedBuffer = Buffer.from(expected);
    if (signatureBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

// ==========================================
// 7. ROLE-BASED ACCESS CONTROL (RBAC)
// ==========================================
export function requireRole(allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Authentication is required.'
      });
    }

    const userRole = (req.user.role || 'customer').toUpperCase();
    const normalizedAllowed = allowedRoles.map(r => r.toUpperCase());

    if (!normalizedAllowed.includes(userRole)) {
      return res.status(403).json({
        error: 'FORBIDDEN_INSUFFICIENT_PERMISSIONS',
        message: `Role '${req.user.role}' is not authorized to access this resource. Required: ${allowedRoles.join(', ')}`
      });
    }

    next();
  };
}

// ==========================================
// 8. PROTOTYPE POLLUTION DEFENSE (CWE-1321)
// ==========================================
const DANGEROUS_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function safeDeepMerge<T = any>(target: any, source: any): T {
  if (!source || typeof source !== 'object') return target;
  if (!target || typeof target !== 'object') target = Object.create(null);

  for (const key of Object.keys(source)) {
    if (DANGEROUS_PROTO_KEYS.has(key)) {
      // Reject dangerous prototype pollution keys
      continue;
    }
    const val = source[key];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = Object.create(null);
      }
      safeDeepMerge(target[key], val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

export function sanitizeNoSqlObject(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeNoSqlObject);

  const clean: Record<string, any> = Object.create(null);
  for (const [key, val] of Object.entries(obj)) {
    if (DANGEROUS_PROTO_KEYS.has(key) || key.startsWith('$') || key.includes('.')) {
      // Strip NoSQL operators like $ne, $gt, $regex and prototype keys
      continue;
    }
    clean[key] = sanitizeNoSqlObject(val);
  }
  return clean;
}

// ==========================================
// 9. SSRF & PRIVATE IP BLOCKLIST (CWE-918)
// ==========================================
export function isPrivateOrReservedIp(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return true;
  const cleanIp = ip.trim();

  // IPv6 loopback
  if (cleanIp === '::1' || cleanIp === '::' || cleanIp.startsWith('fe80:')) return true;

  // IPv4 checks
  const parts = cleanIp.split('.').map(p => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(isNaN)) return true;

  const [a, b, c, d] = parts;

  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 10.0.0.0/8 (RFC 1918 Private)
  if (a === 10) return true;
  // 172.16.0.0/12 (RFC 1918 Private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (RFC 1918 Private)
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (Link-local / Cloud IMDS metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
  if (a >= 224) return true;

  return false;
}

export function validateSafeUrl(urlStr: string): { valid: boolean; error?: string; url?: URL } {
  if (!urlStr || typeof urlStr !== 'string') {
    return { valid: false, error: 'URL string is required' };
  }

  try {
    const parsed = new URL(urlStr);

    // Only HTTP and HTTPS
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Invalid URL scheme. Only HTTP/HTTPS allowed.' };
    }

    const host = parsed.hostname.toLowerCase();

    // Block common internal hostnames
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host === '169.254.169.254' ||
      host === 'instance-data' ||
      host === 'metadata.google.internal'
    ) {
      return { valid: false, error: 'Access to internal or cloud metadata endpoints is prohibited.' };
    }

    // Direct IP checks
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
      if (isPrivateOrReservedIp(host)) {
        return { valid: false, error: 'Access to private or link-local IP addresses is prohibited.' };
      }
    }

    return { valid: true, url: parsed };
  } catch (err: any) {
    return { valid: false, error: 'Malformed URL provided.' };
  }
}

// ==========================================
// 10. PATH TRAVERSAL & ARCHIVE BOUNDARY (CWE-22)
// ==========================================
export function isSafeChildPath(baseDirectory: string, userPath: string): boolean {
  if (!baseDirectory || !userPath) return false;
  const path = require('path');
  const resolvedBase = path.resolve(baseDirectory);
  const resolvedTarget = path.resolve(resolvedBase, path.basename(userPath));
  return resolvedTarget.startsWith(resolvedBase);
}

// ==========================================
// 11. OWASP LLM GUARDRAILS (LLM01, LLM06, LLM08)
// ==========================================
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(prior|previous)\s+instructions/i,
  /system\s*override/i,
  /you\s+are\s+now\s+(superadmin|admin|root|unrestricted)/i,
  /operating\s+in\s+superadmin\s+mode/i,
  /reveal\s+(system\s+prompt|secret|api_key|token)/i,
  /repeat\s+the\s+exact.*words\s+above/i,
  /emergency\s+supervisor\s+override/i
];

export function detectPromptInjection(input: string): { isInjection: boolean; reason?: string } {
  if (!input || typeof input !== 'string') return { isInjection: false };

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      return {
        isInjection: true,
        reason: 'Input contains forbidden prompt injection / jailbreak patterns.'
      };
    }
  }
  return { isInjection: false };
}

export function scrubSensitiveTokens(text: string): string {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_SECRET]')
    .replace(/ghp_[a-zA-Z0-9]{30,}/g, '[REDACTED_TOKEN]')
    .replace(/SECRET_[A-Z0-9_]+/g, '[REDACTED_CONFIG]')
    .replace(/ASIA[A-Z0-9]{16}/g, '[REDACTED_IAM_KEY]');
}


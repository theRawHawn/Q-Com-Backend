import { Request, Response, NextFunction } from 'express';
import { getPool } from '../database/connection.js';
import { verifyAccessToken } from '../modules/auth/jwt.js';
import { rbacService, UserAuthContext } from '../modules/rbac/rbacService.js';
import { recordAuditEvent } from '../modules/audit/auditService.js';

// Helper to detect database connection/availability failures
function isDatabaseUnavailable(err: any): boolean {
  if (!err) return false;
  const code = err.code;
  const msg = String(err.message || '');
  return (
    code === 'ECONNREFUSED' ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code === '08006' ||
    code === '08001' ||
    code === '08004' ||
    err.isDatabaseUnavailable === true ||
    msg.includes('Connection terminated') ||
    msg.includes('Database unavailable') ||
    msg.includes('connection error') ||
    msg.includes('client has already been released') ||
    msg.includes('Connection closed')
  );
}

// Extend Express Request type with auth context
declare global {
  namespace Express {
    interface Request {
      auth?: UserAuthContext & {
        sessionId: string;
      };
    }
  }
}

/**
 * Extracts and verifies authentication token (Bearer JWT or Admin Session Token),
 * validates authoritative session in PostgreSQL, checks suspension status,
 * and attaches full user context to req.auth.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'] || req.headers['x-admin-session-token'];

  if (!authHeader) {
    res.status(401).json({
      success: false,
      error: 'UNAUTHENTICATED',
      message: 'Authentication token is required to access this resource.',
    });
    return;
  }

  let token = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (token.startsWith('Bearer ')) {
    token = token.slice(7).trim();
  }

  try {
    // 1. Verify cryptographic JWT structure & signature
    const payload = verifyAccessToken(token);

    // 2. Authoritative PostgreSQL Session Validation
    const pool = getPool();
    const sessionRes = await pool.query(
      `SELECT id, user_id, status, expires_at 
       FROM auth_sessions 
       WHERE id = $1 AND user_id = $2`,
      [payload.session_id, payload.sub]
    );

    if (sessionRes.rows.length === 0) {
      res.status(401).json({
        success: false,
        error: 'SESSION_NOT_FOUND',
        message: 'The session associated with this token does not exist.',
      });
      return;
    }

    const session = sessionRes.rows[0];
    if (session.status !== 'ACTIVE') {
      res.status(401).json({
        success: false,
        error: 'SESSION_REVOKED',
        message: 'This session has been revoked or terminated.',
      });
      return;
    }

    if (new Date(session.expires_at).getTime() < Date.now()) {
      res.status(401).json({
        success: false,
        error: 'SESSION_EXPIRED',
        message: 'Your session has expired. Please log in again.',
      });
      return;
    }

    // 3. Resolve Authoritative User Auth Context (Roles, Permissions, Tenant Scopes)
    const userContext = await rbacService.getUserAuthContext(payload.sub, pool);
    if (!userContext) {
      res.status(401).json({
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'The user identity for this session no longer exists.',
      });
      return;
    }

    // 4. Enforce Account Suspension Status
    if (userContext.isSuspended) {
      await recordAuditEvent({
        actorId: userContext.userId,
        actorType: 'USER',
        action: 'AUTHENTICATED_REQUEST_BLOCKED_SUSPENDED',
        entityType: 'USER',
        entityId: userContext.userId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(403).json({
        success: false,
        error: 'ACCOUNT_SUSPENDED',
        message: `Account is suspended: ${userContext.suspensionReason || 'Access denied by platform administrator.'}`,
      });
      return;
    }

    // 5. Attach authoritative context to request
    req.auth = {
      ...userContext,
      sessionId: session.id,
    };

    next();
  } catch (err: any) {
    if (isDatabaseUnavailable(err)) {
      res.setHeader('Retry-After', '3');
      res.status(503).json({
        success: false,
        error: 'DATABASE_UNAVAILABLE',
        message: 'PostgreSQL database is currently unavailable. Please retry using the same Idempotency-Key.',
        retryAfterSeconds: 3,
      });
      return;
    }

    res.status(401).json({
      success: false,
      error: 'INVALID_TOKEN',
      message: err.message || 'Token validation failed.',
    });
  }
}

/**
 * Optional authentication: Populates req.auth if a valid token is provided,
 * otherwise allows unauthenticated request through.
 */
export async function optionalAuthenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'] || req.headers['x-admin-session-token'];
  if (!authHeader) {
    return next();
  }
  return authenticate(req, res, next);
}

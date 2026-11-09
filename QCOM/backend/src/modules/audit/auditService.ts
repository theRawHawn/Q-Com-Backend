import pg from 'pg';
import { getPool } from '../../database/connection.js';

export interface AuditEventParams {
  actorId: string;
  actorType: 'USER' | 'CUSTOMER' | 'SELLER' | 'RIDER' | 'ADMIN' | 'SYSTEM';
  action: string;
  entityType: string;
  entityId: string;
  oldState?: any;
  newState?: any;
  ipAddress?: string;
  userAgent?: string;
  poolOverride?: pg.Pool;
}

/**
 * Strips sensitive keys (passwords, OTPs, tokens, secrets) before persisting audit logs.
 */
function sanitizeAuditPayload(data: any): any {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(sanitizeAuditPayload);

  const sensitiveKeys = new Set([
    'password',
    'otp',
    'otp_hash',
    'token',
    'token_hash',
    'accesstoken',
    'refreshtoken',
    'secret',
    'jwt_secret',
    'pin',
    'authorization',
  ]);

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (sensitiveKeys.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED_SECRET]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeAuditPayload(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Centralized Audit Logging Service for Security, RBAC, and Authentication Mutations.
 */
export async function recordAuditEvent(params: AuditEventParams): Promise<void> {
  const runner = params.poolOverride || getPool();

  try {
    const cleanOldState = params.oldState ? JSON.stringify(sanitizeAuditPayload(params.oldState)) : null;
    const cleanNewState = params.newState ? JSON.stringify(sanitizeAuditPayload(params.newState)) : null;

    await runner.query(
      `INSERT INTO audit_logs 
       (actor_id, actor_type, action, entity_type, entity_id, old_state, new_state, ip_address, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        params.actorId || 'SYSTEM',
        params.actorType,
        params.action,
        params.entityType,
        params.entityId || 'N/A',
        cleanOldState,
        cleanNewState,
        params.ipAddress || null,
        params.userAgent || null,
      ]
    );
  } catch (err: any) {
    // Log error to console without breaking the parent transaction / flow
    console.error(`[AuditService] Failed to record audit log for action ${params.action}:`, err.message);
  }
}

/**
 * Sprint 15.8: Durable PostgreSQL-Backed Idempotency Service
 * Enforces operation-scoped, actor-scoped, canonical-fingerprinted idempotency
 * backed authoritatively by PostgreSQL idempotency_keys table — survives restarts,
 * crashes, multi-instance concurrency, and total Redis outages.
 */

import crypto from 'crypto';
import pg from 'pg';
import { getPool } from '../../database/connection.js';
import { paymentLogger } from './paymentLogger.js';

export type IdempotencyClaimResult =
  | { claimed: true }
  | { claimed: false; status: 'COMPLETED'; statusCode: number; responseBody: any }
  | { claimed: false; status: 'PROCESSING'; conflictError: string }
  | { claimed: false; status: 'MISMATCH'; mismatchError: string }
  | { claimed: false; status: 'SCOPE_MISMATCH'; scopeError: string }
  | { claimed: false; status: 'UNAUTHORIZED'; authError: string };

export interface ClaimIdempotencyParams {
  pool?: pg.Pool | pg.PoolClient;
  idempotencyKey: string;
  actorId: string;
  operationType: string;
  endpoint: string;
  requestFingerprint: string;
  processingLeaseSec?: number;
  ttlHours?: number;
}

/**
 * Produces deterministic canonical JSON serialization with sorted keys
 * so equivalent payloads always yield identical SHA-256 fingerprints.
 */
export function canonicalizePayload(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalizePayload(v)).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalizePayload((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

export function computeCanonicalFingerprint(payload: unknown): string {
  return crypto.createHash('sha256').update(canonicalizePayload(payload)).digest('hex');
}

function isUniqueConstraintError(err: any): boolean {
  if (!err) return false;
  return (
    err.code === '23505' ||
    String(err.message || '').toLowerCase().includes('unique') ||
    String(err.message || '').toLowerCase().includes('duplicate')
  );
}

class IdempotencyService {
  /**
   * Atomically claims or resolves an idempotency key in PostgreSQL.
   * Performs actor ownership, operation/endpoint scoping, canonical payload fingerprint,
   * expiry, stale-lock reclamation, and 23505 concurrency race validation.
   */
  public async claimKey(params: ClaimIdempotencyParams): Promise<IdempotencyClaimResult> {
    const runner = params.pool || getPool();
    const {
      idempotencyKey,
      actorId,
      operationType,
      endpoint,
      requestFingerprint,
      processingLeaseSec = 120,
      ttlHours = 24,
    } = params;
    const lockedUntilDate = new Date(Date.now() + processingLeaseSec * 1000);
    const expiresAtDate = new Date(Date.now() + ttlHours * 3600 * 1000);

    const validateExisting = async (existing: any): Promise<IdempotencyClaimResult> => {
      // 1. Actor boundary check (prevent cross-user hijacking)
      if (existing.actor_id && existing.actor_id !== actorId) {
        paymentLogger.increment('duplicateBlocks');
        return {
          claimed: false,
          status: 'UNAUTHORIZED',
          authError: 'This Idempotency-Key belongs to a different user account.',
        };
      }

      // 2. Operation/endpoint boundary check
      const existingOp = existing.operation_type || 'GENERAL';
      if (existingOp !== 'GENERAL' && existingOp !== operationType) {
        paymentLogger.increment('duplicateBlocks');
        return {
          claimed: false,
          status: 'SCOPE_MISMATCH',
          scopeError: `This Idempotency-Key is bound to operation '${existingOp}' and cannot be reused for '${operationType}'.`,
        };
      }

      // 3. Payload fingerprint mismatch check
      if (existing.request_fingerprint && existing.request_fingerprint !== requestFingerprint) {
        paymentLogger.increment('duplicateBlocks');
        return {
          claimed: false,
          status: 'MISMATCH',
          mismatchError: 'This Idempotency-Key was already used with a different request payload.',
        };
      }

      // 4. Expiration check: if expired, reclaim cleanly within actor scope
      const isExpired = existing.expires_at && new Date(existing.expires_at).getTime() <= Date.now();
      if (isExpired) {
        const reclaimedExpired = await runner.query(
          `UPDATE idempotency_keys
           SET status = 'PROCESSING',
               operation_type = $1,
               endpoint = $2,
               request_fingerprint = $3,
               status_code = NULL,
               response_body = NULL,
               locked_until = $4,
               created_at = NOW(),
               updated_at = NOW(),
               expires_at = $5
           WHERE idempotency_key = $6
             AND (actor_id = $7 OR actor_id IS NULL)
             AND expires_at <= NOW()
           RETURNING idempotency_key`,
          [operationType, endpoint, requestFingerprint, lockedUntilDate, expiresAtDate, idempotencyKey, actorId]
        );
        if (reclaimedExpired.rows.length > 0) {
          return { claimed: true };
        }
      }

      // 5. Completed replay (plus RECONCILIATION_REQUIRED live resolution upgrade)
      if (existing.status === 'COMPLETED') {
        const cachedBody =
          typeof existing.response_body === 'string'
            ? JSON.parse(existing.response_body)
            : existing.response_body;

        if (
          existing.status_code === 202 ||
          cachedBody?.status === 'RECONCILIATION_REQUIRED' ||
          cachedBody?.isReconciliationRequired === true
        ) {
          const orderId =
            cachedBody?.order?.id || cachedBody?.orderId || cachedBody?.paymentReceipt?.orderId;
          if (orderId) {
            const durableRes = await runner.query(
              `SELECT o.id, o.status, o.payment_status, pi.status AS intent_status
               FROM orders o
               LEFT JOIN payment_intents pi ON pi.order_id = o.id
               WHERE o.id = $1
               ORDER BY pi.created_at DESC
               LIMIT 1`,
              [orderId]
            );
            if (durableRes.rows.length > 0) {
              const row = durableRes.rows[0];
              if (row.payment_status === 'PAID' || row.intent_status === 'CAPTURED') {
                const updatedBody = {
                  ...cachedBody,
                  success: true,
                  message: 'Payment verified and captured successfully (reconciliation resolved).',
                  order: {
                    ...cachedBody.order,
                    id: row.id,
                    status: row.status,
                    payment_status: row.payment_status,
                  },
                  isDuplicate: false,
                  isReconciliationRequired: false,
                  status: 'CAPTURED',
                };
                await runner.query(
                  `UPDATE idempotency_keys
                   SET status_code = 200, response_body = $1, updated_at = NOW()
                   WHERE idempotency_key = $2`,
                  [JSON.stringify(updatedBody), idempotencyKey]
                );
                return {
                  claimed: false,
                  status: 'COMPLETED',
                  statusCode: 200,
                  responseBody: updatedBody,
                };
              }
            }
          }
        }

        return {
          claimed: false,
          status: 'COMPLETED',
          statusCode: existing.status_code || 200,
          responseBody: existing.response_body,
        };
      }

      // 6. Active PROCESSING lock check
      if (existing.status === 'PROCESSING') {
        const lockDeadline = existing.locked_until
          ? new Date(existing.locked_until).getTime()
          : new Date(existing.created_at || Date.now()).getTime() + processingLeaseSec * 1000;
        if (lockDeadline > Date.now()) {
          return {
            claimed: false,
            status: 'PROCESSING',
            conflictError: 'An operation with this Idempotency-Key is currently in progress.',
          };
        }
      }

      // 7. Reclaim FAILED or stale PROCESSING lease
      const reclaimRes = await runner.query(
        `UPDATE idempotency_keys
         SET status = 'PROCESSING',
             operation_type = $1,
             endpoint = $2,
             request_fingerprint = $3,
             locked_until = $4,
             created_at = NOW(),
             updated_at = NOW()
         WHERE idempotency_key = $5
           AND (actor_id = $6 OR actor_id IS NULL)
           AND (status = 'FAILED' OR locked_until IS NULL OR locked_until <= NOW())
         RETURNING idempotency_key`,
        [operationType, endpoint, requestFingerprint, lockedUntilDate, idempotencyKey, actorId]
      );

      if (reclaimRes.rows.length > 0) {
        return { claimed: true };
      }

      return {
        claimed: false,
        status: 'PROCESSING',
        conflictError: 'An operation with this Idempotency-Key is currently in progress.',
      };
    };

    // Fast path lookup
    const existingRes = await runner.query(
      `SELECT idempotency_key, actor_id, operation_type, endpoint, status,
              request_fingerprint, status_code, response_body, created_at, expires_at, locked_until
       FROM idempotency_keys
       WHERE idempotency_key = $1`,
      [idempotencyKey]
    );

    if (existingRes.rows.length > 0) {
      return validateExisting(existingRes.rows[0]);
    }

    // Atomic initial claim backed by PostgreSQL PRIMARY KEY uniqueness
    try {
      await runner.query(
        `INSERT INTO idempotency_keys (
           idempotency_key, actor_id, operation_type, endpoint, status,
           request_fingerprint, locked_until, created_at, updated_at, expires_at
         )
         VALUES (
           $1, $2, $3, $4, 'PROCESSING',
           $5, $6, NOW(), NOW(), $7
         )`,
        [
          idempotencyKey,
          actorId,
          operationType,
          endpoint,
          requestFingerprint,
          lockedUntilDate,
          expiresAtDate,
        ]
      );
      return { claimed: true };
    } catch (err: any) {
      if (isUniqueConstraintError(err)) {
        const raceRes = await runner.query(
          `SELECT idempotency_key, actor_id, operation_type, endpoint, status,
                  request_fingerprint, status_code, response_body, created_at, expires_at, locked_until
           FROM idempotency_keys
           WHERE idempotency_key = $1`,
          [idempotencyKey]
        );
        if (raceRes.rows.length > 0) {
          return validateExisting(raceRes.rows[0]);
        }
      }
      throw err;
    }
  }

  public async markCompleted(
    poolOrClient: pg.Pool | pg.PoolClient | undefined,
    idempotencyKey: string,
    statusCode: number,
    responseBody: any
  ): Promise<void> {
    const runner = poolOrClient || getPool();
    await runner.query(
      `UPDATE idempotency_keys
       SET status = 'COMPLETED',
           status_code = $1,
           response_body = $2,
           locked_until = NULL,
           updated_at = NOW()
       WHERE idempotency_key = $3`,
      [statusCode, JSON.stringify(responseBody), idempotencyKey]
    );
  }

  public async markFailed(
    poolOrClient: pg.Pool | pg.PoolClient | undefined,
    idempotencyKey: string,
    statusCode?: number,
    responseBody?: any
  ): Promise<void> {
    const runner = poolOrClient || getPool();
    await runner.query(
      `UPDATE idempotency_keys
       SET status = 'FAILED',
           status_code = COALESCE($1, status_code),
           response_body = COALESCE($2, response_body),
           locked_until = NULL,
           updated_at = NOW()
       WHERE idempotency_key = $3`,
      [statusCode ?? null, responseBody ? JSON.stringify(responseBody) : null, idempotencyKey]
    );
  }
}

export const idempotencyService = new IdempotencyService();

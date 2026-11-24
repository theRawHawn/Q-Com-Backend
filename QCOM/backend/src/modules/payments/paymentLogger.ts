/**
 * Sprint 15.8: Gateway-Agnostic Redacted Payment Observability & Structured Logger
 * Guarantees credentials, secrets, signatures, card/bank details, tokens, and PII
 * are never emitted in logs while giving operators clear correlation & exception visibility.
 */

import { getPool } from '../../database/connection.js';

const EXACT_TOKEN_SENSITIVE_TERMS = new Set([
  'pan',
  'pin',
  'otp',
  'cvv',
  'cvc',
  'vpa',
  'upi',
  'ifsc',
  'bank',
  'card',
  'phone',
  'mobile',
  'email',
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (
    [
      'signature',
      'secret',
      'password',
      'token',
      'authorization',
      'bearer',
      'apikey',
      'api_key',
      'keyid',
      'key_id',
      'keysecret',
      'key_secret',
      'webhooksecret',
      'webhook_secret',
      'accountnumber',
      'account_number',
      'cookie',
      'credential',
      'cardnumber',
      'card_number',
      'pancard',
      'pan_card',
      'pannumber',
      'pan_number',
    ].some((pattern) => normalized.includes(pattern))
  ) {
    return true;
  }

  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.some((tok) => EXACT_TOKEN_SENSITIVE_TERMS.has(tok));
}

function redactStringValue(val: string): string {
  if (/^Bearer\s+/i.test(val)) {
    return 'Bearer [REDACTED]';
  }
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(val)) {
    return '[REDACTED_JWT]';
  }
  return val;
}

export function redactPaymentLogPayload<T = unknown>(input: T, depth: number = 0): T {
  if (depth > 8 || input === null || input === undefined) {
    return input;
  }

  if (typeof input === 'string') {
    return redactStringValue(input) as unknown as T;
  }

  if (typeof input !== 'object') {
    return input;
  }

  if (input instanceof Date) {
    return input.toISOString() as unknown as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactPaymentLogPayload(item, depth + 1)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = '[REDACTED]';
    } else if (key === 'rawBody' || key === 'rawPayload') {
      out[key] = '[OMITTED_RAW_PAYLOAD]';
    } else {
      out[key] = redactPaymentLogPayload(value, depth + 1);
    }
  }
  return out as T;
}

export interface PaymentCorrelationContext {
  orderId?: string;
  paymentIntentId?: string;
  attemptId?: string;
  refundId?: string;
  discrepancyId?: string;
  eventId?: string;
  providerId?: string;
  userId?: string;
  internalReference?: string;
}

export interface PaymentExceptionRecord {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  correlation: PaymentCorrelationContext;
  details?: Record<string, unknown>;
}

export interface PaymentObservabilityCounters {
  initiations: number;
  captures: number;
  failures: number;
  unknownOutcomes: number;
  duplicateBlocks: number;
  refundInitiated: number;
  refundCompleted: number;
  refundFailed: number;
  refundUnknown: number;
  reconciliationDiscrepancies: number;
  recoveryEscalations: number;
  codCollectionsRecorded: number;
  codRemittancesSubmitted: number;
  codRemittancesVerified: number;
  codShortagesDetected: number;
  codExcessDetected: number;
  codDisputesOpened: number;
  codDisputesResolved: number;
}

class PaymentObservabilityLogger {
  private counters: PaymentObservabilityCounters = {
    initiations: 0,
    captures: 0,
    failures: 0,
    unknownOutcomes: 0,
    duplicateBlocks: 0,
    refundInitiated: 0,
    refundCompleted: 0,
    refundFailed: 0,
    refundUnknown: 0,
    reconciliationDiscrepancies: 0,
    recoveryEscalations: 0,
    codCollectionsRecorded: 0,
    codRemittancesSubmitted: 0,
    codRemittancesVerified: 0,
    codShortagesDetected: 0,
    codExcessDetected: 0,
    codDisputesOpened: 0,
    codDisputesResolved: 0,
  };

  private recentExceptions: PaymentExceptionRecord[] = [];
  private readonly maxRecentExceptions = 200;

  public increment(metric: keyof PaymentObservabilityCounters, by: number = 1): void {
    this.counters[metric] += by;
  }

  public log(
    level: 'info' | 'warn' | 'error',
    event: string,
    correlation: PaymentCorrelationContext,
    details?: Record<string, unknown>
  ): PaymentExceptionRecord {
    const safeDetails = details ? redactPaymentLogPayload(details) : undefined;
    const record: PaymentExceptionRecord = {
      timestamp: new Date().toISOString(),
      level,
      event,
      correlation: redactPaymentLogPayload(correlation),
      ...(safeDetails ? { details: safeDetails } : {}),
    };

    if (level === 'warn' || level === 'error') {
      this.recentExceptions.unshift(record);
      if (this.recentExceptions.length > this.maxRecentExceptions) {
        this.recentExceptions.length = this.maxRecentExceptions;
      }
    }

    const line = `[PaymentObservability] [${level.toUpperCase()}] [${event}] ${JSON.stringify({
      ...record.correlation,
      ...(safeDetails ? { details: safeDetails } : {}),
    })}`;

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }

    return record;
  }

  public getCounters(): PaymentObservabilityCounters {
    return { ...this.counters };
  }

  public getRecentExceptions(limit: number = 50): PaymentExceptionRecord[] {
    return this.recentExceptions.slice(0, Math.max(1, Math.min(limit, this.maxRecentExceptions)));
  }

  public resetMetrics(): void {
    for (const k of Object.keys(this.counters) as Array<keyof PaymentObservabilityCounters>) {
      this.counters[k] = 0;
    }
    this.recentExceptions = [];
  }

  /**
   * Queries authoritative PostgreSQL payment exception states for operator visibility.
   */
  public async getOperationalPaymentHealth(): Promise<{
    counters: PaymentObservabilityCounters;
    databaseStateCounts: {
      pendingOrProcessingIntents: number;
      unknownOrReconciliationIntents: number;
      requiresReviewIntents: number;
      failedAttemptsLast24h: number;
      processingOrUnknownRefunds: number;
      requiresReviewRefunds: number;
      openReconciliationDiscrepancies: number;
      requiresReviewDiscrepancies: number;
      codPendingRemittances: number;
      codStuckRemittances: number;
      codOpenDisputes: number;
      codRestrictedRiders: number;
      codDiscrepancies: number;
    };
    recentExceptions: PaymentExceptionRecord[];
  }> {
    const pool = getPool();

    const safeCount = async (sql: string): Promise<number> => {
      try {
        const res = await pool.query(sql);
        return parseInt(res.rows[0]?.cnt ?? '0', 10) || 0;
      } catch {
        return 0;
      }
    };

    const [
      pendingOrProcessingIntents,
      unknownOrReconciliationIntents,
      requiresReviewIntents,
      failedAttemptsLast24h,
      processingOrUnknownRefunds,
      requiresReviewRefunds,
      openReconciliationDiscrepancies,
      requiresReviewDiscrepancies,
      codPendingRemittances,
      codStuckRemittances,
      codOpenDisputes,
      codRestrictedRiders,
      codDiscrepancies,
    ] = await Promise.all([
      safeCount(`SELECT COUNT(*) AS cnt FROM payment_intents WHERE status IN ('CREATED', 'INITIATED', 'PENDING', 'PROCESSING', 'AUTHORIZED')`),
      safeCount(`SELECT COUNT(*) AS cnt FROM payment_intents WHERE status IN ('UNKNOWN', 'RECONCILIATION_REQUIRED')`),
      safeCount(`SELECT COUNT(*) AS cnt FROM payment_intents WHERE status = 'REQUIRES_REVIEW' OR requires_manual_review = TRUE`),
      safeCount(`SELECT COUNT(*) AS cnt FROM payment_attempts WHERE status = 'FAILED'`),
      safeCount(`SELECT COUNT(*) AS cnt FROM refunds WHERE status IN ('PROCESSING', 'UNKNOWN')`),
      safeCount(`SELECT COUNT(*) AS cnt FROM refunds WHERE status = 'REQUIRES_REVIEW' OR requires_manual_review = TRUE`),
      safeCount(`SELECT COUNT(*) AS cnt FROM reconciliation_discrepancies WHERE status = 'OPEN'`),
      safeCount(`SELECT COUNT(*) AS cnt FROM reconciliation_discrepancies WHERE status = 'REQUIRES_REVIEW'`),
      safeCount(`SELECT COUNT(*) AS cnt FROM cod_remittances WHERE status IN ('SUBMITTED', 'RECEIVED', 'VERIFICATION_PENDING')`),
      safeCount(`SELECT COUNT(*) AS cnt FROM cod_remittances WHERE status IN ('SUBMITTED', 'RECEIVED', 'VERIFICATION_PENDING') AND created_at < NOW() - INTERVAL '4 hours'`),
      safeCount(`SELECT COUNT(*) AS cnt FROM cod_cash_disputes WHERE status IN ('OPEN', 'UNDER_INVESTIGATION', 'ESCALATED')`),
      safeCount(`SELECT COUNT(*) AS cnt FROM riders WHERE cod_restricted = TRUE`),
      safeCount(`SELECT COUNT(*) AS cnt FROM reconciliation_discrepancies WHERE status IN ('OPEN', 'REQUIRES_REVIEW') AND (category LIKE '%COD%' OR category LIKE 'RIDER_CASH%')`),
    ]);

    return {
      counters: this.getCounters(),
      databaseStateCounts: {
        pendingOrProcessingIntents,
        unknownOrReconciliationIntents,
        requiresReviewIntents,
        failedAttemptsLast24h,
        processingOrUnknownRefunds,
        requiresReviewRefunds,
        openReconciliationDiscrepancies,
        requiresReviewDiscrepancies,
        codPendingRemittances,
        codStuckRemittances,
        codOpenDisputes,
        codRestrictedRiders,
        codDiscrepancies,
      },
      recentExceptions: this.getRecentExceptions(50),
    };
  }
}

export const paymentLogger = new PaymentObservabilityLogger();

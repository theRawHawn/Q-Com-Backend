/**
 * Sprint 12.0 & Sprint 15.8: Authoritative Provider-Agnostic Payment State Machine
 * Consolidates deterministic transitions across Payment Intents, Payment Attempts, and Refunds
 * with atomic PostgreSQL row-locked & version-checked transition enforcement.
 */

import pg from 'pg';

export type PaymentState =
  | 'CREATED'
  | 'INITIATED'
  | 'PENDING'
  | 'PROCESSING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'UNKNOWN'
  | 'RECONCILIATION_REQUIRED'
  | 'REQUIRES_REVIEW'
  | 'REFUND_PENDING'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED';

export type PaymentAttemptState =
  | 'INITIATED'
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'UNKNOWN'
  | 'RECONCILIATION_REQUIRED'
  | 'REQUIRES_REVIEW';

export type RefundState =
  | 'REQUESTED'
  | 'PENDING'
  | 'PROCESSING'
  | 'UNKNOWN'
  | 'COMPLETED'
  | 'FAILED'
  | 'REQUIRES_REVIEW';

export type FailureClassification = 'TRANSIENT' | 'PERMANENT' | 'AMBIGUOUS' | 'POLICY';

export const ALL_PAYMENT_STATES: readonly PaymentState[] = [
  'CREATED',
  'INITIATED',
  'PENDING',
  'PROCESSING',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'UNKNOWN',
  'RECONCILIATION_REQUIRED',
  'REQUIRES_REVIEW',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const;

export const TERMINAL_PAYMENT_STATES: ReadonlySet<PaymentState> = new Set([
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
]);

export const ACTIVE_INTENT_STATES: readonly PaymentState[] = [
  'CREATED',
  'INITIATED',
  'PENDING',
  'PROCESSING',
  'AUTHORIZED',
  'UNKNOWN',
  'RECONCILIATION_REQUIRED',
  'REQUIRES_REVIEW',
];

const ALLOWED_TRANSITIONS: Record<PaymentState, ReadonlySet<PaymentState>> = {
  CREATED: new Set([
    'INITIATED',
    'PENDING',
    'PROCESSING',
    'AUTHORIZED',
    'CAPTURED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'UNKNOWN',
    'RECONCILIATION_REQUIRED',
    'REQUIRES_REVIEW',
  ]),
  INITIATED: new Set([
    'PENDING',
    'PROCESSING',
    'AUTHORIZED',
    'CAPTURED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'UNKNOWN',
    'RECONCILIATION_REQUIRED',
    'REQUIRES_REVIEW',
  ]),
  PENDING: new Set([
    'INITIATED',
    'PROCESSING',
    'AUTHORIZED',
    'CAPTURED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'UNKNOWN',
    'RECONCILIATION_REQUIRED',
    'REQUIRES_REVIEW',
  ]),
  PROCESSING: new Set([
    'AUTHORIZED',
    'CAPTURED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'UNKNOWN',
    'RECONCILIATION_REQUIRED',
    'REQUIRES_REVIEW',
  ]),
  AUTHORIZED: new Set([
    'CAPTURED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'UNKNOWN',
    'RECONCILIATION_REQUIRED',
    'REQUIRES_REVIEW',
  ]),
  UNKNOWN: new Set([
    'CAPTURED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'RECONCILIATION_REQUIRED',
    'REQUIRES_REVIEW',
    'REFUND_PENDING',
  ]),
  RECONCILIATION_REQUIRED: new Set([
    'CAPTURED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'UNKNOWN',
    'REQUIRES_REVIEW',
    'REFUND_PENDING',
  ]),
  REQUIRES_REVIEW: new Set([
    'CAPTURED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'REFUND_PENDING',
    'REFUNDED',
  ]),
  CAPTURED: new Set(['REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED']),
  REFUND_PENDING: new Set(['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REQUIRES_REVIEW']),
  PARTIALLY_REFUNDED: new Set(['REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED']),
  FAILED: new Set([]),
  CANCELLED: new Set([]),
  EXPIRED: new Set([]),
  REFUNDED: new Set([]),
};

const ALLOWED_ATTEMPT_TRANSITIONS: Record<PaymentAttemptState, ReadonlySet<PaymentAttemptState>> = {
  INITIATED: new Set([
    'PENDING',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'UNKNOWN',
    'RECONCILIATION_REQUIRED',
    'REQUIRES_REVIEW',
  ]),
  PENDING: new Set([
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'UNKNOWN',
    'RECONCILIATION_REQUIRED',
    'REQUIRES_REVIEW',
  ]),
  PROCESSING: new Set([
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'UNKNOWN',
    'RECONCILIATION_REQUIRED',
    'REQUIRES_REVIEW',
  ]),
  UNKNOWN: new Set([
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'RECONCILIATION_REQUIRED',
    'REQUIRES_REVIEW',
  ]),
  RECONCILIATION_REQUIRED: new Set([
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'UNKNOWN',
    'REQUIRES_REVIEW',
  ]),
  REQUIRES_REVIEW: new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']),
  SUCCEEDED: new Set([]),
  FAILED: new Set([]),
  CANCELLED: new Set([]),
  EXPIRED: new Set([]),
};

const ALLOWED_REFUND_TRANSITIONS: Record<RefundState, ReadonlySet<RefundState>> = {
  REQUESTED: new Set(['PENDING', 'PROCESSING', 'UNKNOWN', 'COMPLETED', 'FAILED', 'REQUIRES_REVIEW']),
  PENDING: new Set(['PROCESSING', 'UNKNOWN', 'COMPLETED', 'FAILED', 'REQUIRES_REVIEW']),
  PROCESSING: new Set(['UNKNOWN', 'COMPLETED', 'FAILED', 'REQUIRES_REVIEW']),
  UNKNOWN: new Set(['PROCESSING', 'COMPLETED', 'FAILED', 'REQUIRES_REVIEW']),
  REQUIRES_REVIEW: new Set(['PROCESSING', 'COMPLETED', 'FAILED']),
  COMPLETED: new Set([]),
  FAILED: new Set(['PENDING', 'PROCESSING']),
};

export const PAYMENT_STATE_TRANSITION_MATRIX: Readonly<Record<PaymentState, readonly PaymentState[]>> = Object.freeze(
  ALL_PAYMENT_STATES.reduce((acc, s) => {
    acc[s] = Array.from(ALLOWED_TRANSITIONS[s]);
    return acc;
  }, {} as Record<PaymentState, readonly PaymentState[]>)
);

export interface TransitionValidationResult {
  valid: boolean;
  isDuplicate: boolean;
  error?: string;
}

export function isTerminalPaymentState(state: PaymentState): boolean {
  return TERMINAL_PAYMENT_STATES.has(state);
}

/**
 * Validates a requested payment intent status transition.
 * Returns valid=true if allowed or if it represents a safe idempotent repeat transition.
 */
export function validatePaymentTransition(
  fromState: PaymentState,
  toState: PaymentState
): TransitionValidationResult {
  if (fromState === toState) {
    return { valid: true, isDuplicate: true };
  }

  if (isTerminalPaymentState(fromState)) {
    return {
      valid: false,
      isDuplicate: false,
      error: `INVALID_PAYMENT_STATE_TRANSITION: Cannot transition out of terminal state '${fromState}' to '${toState}'.`,
    };
  }

  if (fromState === 'CAPTURED' && !ALLOWED_TRANSITIONS.CAPTURED.has(toState)) {
    return {
      valid: false,
      isDuplicate: false,
      error: `INVALID_PAYMENT_STATE_TRANSITION: Payment has already been CAPTURED. Transition to '${toState}' is forbidden.`,
    };
  }

  const allowedNext = ALLOWED_TRANSITIONS[fromState];
  if (allowedNext && allowedNext.has(toState)) {
    return { valid: true, isDuplicate: false };
  }

  return {
    valid: false,
    isDuplicate: false,
    error: `INVALID_PAYMENT_STATE_TRANSITION: Illegal transition from '${fromState}' to '${toState}'.`,
  };
}

export function validateAttemptTransition(
  fromState: PaymentAttemptState,
  toState: PaymentAttemptState
): TransitionValidationResult {
  if (fromState === toState) {
    return { valid: true, isDuplicate: true };
  }

  const allowed = ALLOWED_ATTEMPT_TRANSITIONS[fromState];
  if (allowed && allowed.has(toState)) {
    return { valid: true, isDuplicate: false };
  }

  return {
    valid: false,
    isDuplicate: false,
    error: `INVALID_ATTEMPT_STATE_TRANSITION: Illegal attempt transition from '${fromState}' to '${toState}'.`,
  };
}

export function validateRefundTransition(
  fromState: RefundState,
  toState: RefundState
): TransitionValidationResult {
  if (fromState === toState) {
    return { valid: true, isDuplicate: true };
  }

  const allowed = ALLOWED_REFUND_TRANSITIONS[fromState];
  if (allowed && allowed.has(toState)) {
    return { valid: true, isDuplicate: false };
  }

  return {
    valid: false,
    isDuplicate: false,
    error: `INVALID_REFUND_STATE_TRANSITION: Illegal refund transition from '${fromState}' to '${toState}'.`,
  };
}

export interface IntentTransitionOptions {
  providerPaymentId?: string;
  providerOrderId?: string;
  internalTransactionReference?: string;
  errorCode?: string | null;
  errorDescription?: string | null;
  failureClassification?: FailureClassification | null;
  nextRetryAt?: Date | null;
  requiresManualReview?: boolean;
  /**
   * Audited override strictly for late authoritative capture arriving after
   * an order/intent was cancelled or expired: routes payment obligation to
   * REFUND_PENDING (never silently revives cancelled order or moves back to CAPTURED).
   */
  allowLateCaptureCompensation?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Authoritative PostgreSQL state transition helper for payment_intents.
 * Enforces row-level lock (FOR UPDATE), state machine graph validation,
 * optimistic version CAS check, and terminal timestamp stamping.
 */
export async function transitionPaymentIntentState(
  client: pg.PoolClient,
  intentId: string,
  toState: PaymentState,
  options: IntentTransitionOptions = {}
): Promise<{
  previousState: PaymentState;
  currentState: PaymentState;
  isDuplicate: boolean;
  version: number;
}> {
  const res = await client.query(
    `SELECT id, status, version, provider_payment_id, provider_order_id, internal_transaction_reference
     FROM payment_intents
     WHERE id = $1
     FOR UPDATE`,
    [intentId]
  );

  if (res.rows.length === 0) {
    throw new Error(`PAYMENT_INTENT_NOT_FOUND: Payment intent '${intentId}' does not exist.`);
  }

  const row = res.rows[0];
  const fromState = row.status as PaymentState;
  const currentVersion = Number(row.version ?? 1);

  const isLateCompensationAllowed =
    options.allowLateCaptureCompensation === true &&
    toState === 'REFUND_PENDING' &&
    fromState !== 'REFUNDED';

  if (!isLateCompensationAllowed) {
    const check = validatePaymentTransition(fromState, toState);
    if (!check.valid) {
      throw new Error(check.error || 'INVALID_PAYMENT_STATE_TRANSITION');
    }
    if (check.isDuplicate && !options.providerPaymentId && !options.internalTransactionReference) {
      return {
        previousState: fromState,
        currentState: fromState,
        isDuplicate: true,
        version: currentVersion,
      };
    }
  }

  const updateRes = await client.query(
    `UPDATE payment_intents
     SET status = $1::varchar,
         provider_payment_id = COALESCE($2, provider_payment_id),
         provider_order_id = COALESCE($3, provider_order_id),
         internal_transaction_reference = COALESCE($4, internal_transaction_reference),
         error_code = CASE WHEN $5::varchar IS NOT NULL THEN $5::varchar ELSE error_code END,
         error_description = CASE WHEN $6::text IS NOT NULL THEN $6::text ELSE error_description END,
         failure_classification = CASE WHEN $7::varchar IS NOT NULL THEN $7::varchar ELSE failure_classification END,
         next_retry_at = $8,
         requires_manual_review = COALESCE($9, requires_manual_review OR ($1::varchar = 'REQUIRES_REVIEW')),
         succeeded_at = CASE WHEN $1::varchar = 'CAPTURED' AND succeeded_at IS NULL THEN NOW() ELSE succeeded_at END,
         failed_at = CASE WHEN $1::varchar = 'FAILED' AND failed_at IS NULL THEN NOW() ELSE failed_at END,
         cancelled_at = CASE WHEN $1::varchar = 'CANCELLED' AND cancelled_at IS NULL THEN NOW() ELSE cancelled_at END,
         expired_at = CASE WHEN $1::varchar = 'EXPIRED' AND expired_at IS NULL THEN NOW() ELSE expired_at END,
         version = version + 1,
         updated_at = NOW()
     WHERE id = $10 AND version = $11
     RETURNING status, version`,
    [
      toState,
      options.providerPaymentId || null,
      options.providerOrderId || null,
      options.internalTransactionReference || null,
      options.errorCode ?? null,
      options.errorDescription ?? null,
      options.failureClassification ?? null,
      options.nextRetryAt ?? null,
      options.requiresManualReview ?? null,
      intentId,
      currentVersion,
    ]
  );

  if (updateRes.rows.length === 0) {
    throw new Error(`PAYMENT_CONCURRENCY_CONFLICT: Optimistic version conflict updating intent '${intentId}'.`);
  }

  return {
    previousState: fromState,
    currentState: updateRes.rows[0].status as PaymentState,
    isDuplicate: fromState === toState,
    version: Number(updateRes.rows[0].version),
  };
}

export interface AttemptTransitionOptions {
  providerReference?: string;
  internalReference?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  failureClassification?: FailureClassification | null;
  retryEligible?: boolean;
  nextRetryAt?: Date | null;
}

/**
 * Authoritative PostgreSQL state transition helper for payment_attempts.
 */
export async function transitionPaymentAttemptState(
  client: pg.PoolClient,
  attemptId: string,
  toState: PaymentAttemptState,
  options: AttemptTransitionOptions = {}
): Promise<{
  previousState: PaymentAttemptState;
  currentState: PaymentAttemptState;
  isDuplicate: boolean;
}> {
  const res = await client.query(
    `SELECT id, status, version FROM payment_attempts WHERE id = $1 FOR UPDATE`,
    [attemptId]
  );
  if (res.rows.length === 0) {
    throw new Error(`PAYMENT_ATTEMPT_NOT_FOUND: Payment attempt '${attemptId}' does not exist.`);
  }

  const row = res.rows[0];
  const fromState = row.status as PaymentAttemptState;
  const currentVersion = Number(row.version ?? 1);

  const check = validateAttemptTransition(fromState, toState);
  if (!check.valid) {
    throw new Error(check.error || 'INVALID_ATTEMPT_STATE_TRANSITION');
  }
  if (check.isDuplicate && !options.providerReference) {
    return { previousState: fromState, currentState: fromState, isDuplicate: true };
  }

  const isCompleted =
    toState === 'SUCCEEDED' || toState === 'FAILED' || toState === 'CANCELLED' || toState === 'EXPIRED';

  const upd = await client.query(
    `UPDATE payment_attempts
     SET status = $1::varchar,
         provider_reference = COALESCE($2, provider_reference),
         internal_reference = COALESCE($3, internal_reference),
         error_code = COALESCE($4, error_code),
         error_message = COALESCE($5, error_message),
         failure_classification = COALESCE($6, failure_classification),
         retry_eligible = COALESCE($7, retry_eligible),
         next_retry_at = $8,
         completed_at = CASE WHEN $9::boolean = TRUE AND completed_at IS NULL THEN NOW() ELSE completed_at END,
         version = version + 1,
         updated_at = NOW()
     WHERE id = $10 AND version = $11
     RETURNING status`,
    [
      toState,
      options.providerReference || null,
      options.internalReference || null,
      options.errorCode || null,
      options.errorMessage || null,
      options.failureClassification || null,
      options.retryEligible ?? null,
      options.nextRetryAt ?? null,
      isCompleted,
      attemptId,
      currentVersion,
    ]
  );

  if (upd.rows.length === 0) {
    throw new Error(`ATTEMPT_CONCURRENCY_CONFLICT: Optimistic version conflict updating attempt '${attemptId}'.`);
  }

  return {
    previousState: fromState,
    currentState: upd.rows[0].status as PaymentAttemptState,
    isDuplicate: fromState === toState,
  };
}

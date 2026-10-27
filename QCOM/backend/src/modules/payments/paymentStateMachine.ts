/**
 * Sprint 12.0: Authoritative Provider-Agnostic Payment State Machine
 * Defines deterministic state transitions, terminal guards, and reconciliation workflows.
 */

export type PaymentState =
  | 'CREATED'
  | 'PENDING'
  | 'PROCESSING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'RECONCILIATION_REQUIRED';

export const ALL_PAYMENT_STATES: readonly PaymentState[] = [
  'CREATED',
  'PENDING',
  'PROCESSING',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'RECONCILIATION_REQUIRED',
] as const;

export const TERMINAL_PAYMENT_STATES: ReadonlySet<PaymentState> = new Set([
  'FAILED',
  'CANCELLED',
  'REFUNDED',
]);

const ALLOWED_TRANSITIONS: Record<PaymentState, ReadonlySet<PaymentState>> = {
  CREATED: new Set(['PENDING', 'PROCESSING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'RECONCILIATION_REQUIRED']),
  PENDING: new Set(['PROCESSING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'RECONCILIATION_REQUIRED']),
  PROCESSING: new Set(['AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'RECONCILIATION_REQUIRED']),
  AUTHORIZED: new Set(['CAPTURED', 'FAILED', 'CANCELLED', 'RECONCILIATION_REQUIRED']),
  RECONCILIATION_REQUIRED: new Set(['CAPTURED', 'FAILED', 'CANCELLED', 'REFUND_PENDING']),
  CAPTURED: new Set(['REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED']),
  REFUND_PENDING: new Set(['PARTIALLY_REFUNDED', 'REFUNDED']),
  PARTIALLY_REFUNDED: new Set(['PARTIALLY_REFUNDED', 'REFUNDED']),
  FAILED: new Set([]),
  CANCELLED: new Set([]),
  REFUNDED: new Set([]),
};

export interface TransitionValidationResult {
  valid: boolean;
  isDuplicate: boolean;
  error?: string;
}

export function isTerminalPaymentState(state: PaymentState): boolean {
  return TERMINAL_PAYMENT_STATES.has(state);
}

/**
 * Validates a requested payment status transition.
 * Returns valid=true if allowed or if it represents a safe idempotent repeat transition.
 */
export function validatePaymentTransition(
  fromState: PaymentState,
  toState: PaymentState
): TransitionValidationResult {
  // 1. Same state transition: Safe idempotent outcome
  if (fromState === toState) {
    return {
      valid: true,
      isDuplicate: true,
    };
  }

  // 2. Terminal state violation: Cannot transition out of terminal state
  if (isTerminalPaymentState(fromState)) {
    return {
      valid: false,
      isDuplicate: false,
      error: `INVALID_PAYMENT_STATE_TRANSITION: Cannot transition out of terminal state '${fromState}' to '${toState}'.`,
    };
  }

  // 3. CAPTURED state special rule: Once CAPTURED, cannot revert to pending/processing/failed/cancelled
  if (fromState === 'CAPTURED' && !ALLOWED_TRANSITIONS.CAPTURED.has(toState)) {
    return {
      valid: false,
      isDuplicate: false,
      error: `INVALID_PAYMENT_STATE_TRANSITION: Payment has already been CAPTURED. Transition to '${toState}' is forbidden.`,
    };
  }

  // 4. Check defined transition graph
  const allowedNext = ALLOWED_TRANSITIONS[fromState];
  if (allowedNext && allowedNext.has(toState)) {
    return {
      valid: true,
      isDuplicate: false,
    };
  }

  return {
    valid: false,
    isDuplicate: false,
    error: `INVALID_PAYMENT_STATE_TRANSITION: Illegal transition from '${fromState}' to '${toState}'.`,
  };
}

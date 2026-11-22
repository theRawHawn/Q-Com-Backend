import {
  PaymentState,
  PaymentAttemptState,
  FailureClassification,
} from './paymentStateMachine.js';

export type { PaymentState, PaymentAttemptState, FailureClassification };

export interface PaymentIntent {
  id: string;
  paymentOrderId: string;
  orderId: string;
  userId?: string;
  paymentMethod?: string;
  amount: number;
  currency: string;
  status?: PaymentState;
  signature: string;
  timestamp: string;
  expiresAt?: string;
  succeededAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  expiredAt?: string;
  providerPaymentId?: string;
  providerOrderId?: string;
  activeProvider?: string;
  internalTransactionReference?: string;
  failureClassification?: FailureClassification;
  requiresManualReview?: boolean;
  version?: number;
  idempotencyKey?: string;
}

export interface PaymentAttempt {
  id: string;
  orderId: string;
  paymentIntentId: string;
  attemptNumber: number;
  providerId: string;
  providerReference?: string;
  internalReference?: string;
  status: PaymentAttemptState;
  amount: number;
  currency: string;
  idempotencyKey?: string;
  errorCode?: string;
  errorMessage?: string;
  failureClassification?: FailureClassification;
  retryEligible?: boolean;
  nextRetryAt?: string;
  expiresAt?: string;
  initiatedAt: string;
  completedAt?: string;
}

export interface PaymentTransaction {
  id: string;
  internalReference: string;
  orderId: string;
  paymentIntentId?: string;
  paymentAttemptId?: string;
  refundId?: string;
  transactionType: 'AUTHORIZATION' | 'CAPTURE' | 'REFUND' | 'REVERSAL' | 'VOID' | 'CHARGEBACK' | 'STATUS_CHECK';
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';
  amount: number;
  currency: string;
  paymentMode?: string;
  providerId: string;
  externalReference?: string;
  idempotencyKey?: string;
  ledgerTransactionReference?: string;
  occurredAt: string;
}

export interface PaymentReceipt {
  id: string;
  orderId: string;
  transactionId: string;
  amount: number;
  status: 'SUCCESS' | 'FAILED' | 'REFUNDED';
  signature: string;
  verifiedAt: string;
}

export interface WebhookProcessingResult {
  success: boolean;
  duplicate?: boolean;
  ignored?: boolean;
  eventId: string;
  eventType: string;
  orderId?: string;
  paymentState?: PaymentState;
  message?: string;
}

export interface PaymentStatusSummary {
  orderId: string;
  paymentStatus: string;
  paymentMethod: string;
  totalAmount: number;
  intents: {
    id: string;
    paymentOrderId: string;
    amount: number;
    currency: string;
    status: PaymentState;
    createdAt: string;
    expiresAt?: string;
    succeededAt?: string;
    failedAt?: string;
    cancelledAt?: string;
    expiredAt?: string;
    activeProvider?: string;
    requiresManualReview?: boolean;
  }[];
  attempts?: PaymentAttempt[];
  transactions?: PaymentTransaction[];
  receipt?: {
    transactionId: string;
    amount: number;
    status: string;
    verifiedAt: string;
  };
}

export interface ReconciliationResult {
  orderId: string;
  status: PaymentState;
  reconciled: boolean;
  action: 'CAPTURED' | 'FAILED' | 'EXPIRED' | 'ESCALATED' | 'ALREADY_FINAL' | 'RECONCILIATION_REQUIRED' | 'UNKNOWN';
  message: string;
  providerPaymentId?: string;
}

import { PaymentState } from './paymentStateMachine.js';

export type { PaymentState };

export interface PaymentIntent {
  id: string;
  paymentOrderId: string;
  orderId: string;
  amount: number;
  currency: string;
  status?: PaymentState;
  signature: string;
  timestamp: string;
  providerPaymentId?: string;
  providerOrderId?: string;
  activeProvider?: string;
  idempotencyKey?: string;
}

export interface PaymentAttempt {
  id: string;
  orderId: string;
  paymentIntentId: string;
  attemptNumber: number;
  providerId: string;
  providerReference?: string;
  status: 'INITIATED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'RECONCILIATION_REQUIRED';
  amount: number;
  currency: string;
  idempotencyKey?: string;
  errorCode?: string;
  errorMessage?: string;
  initiatedAt: string;
  completedAt?: string;
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
    activeProvider?: string;
  }[];
  attempts?: PaymentAttempt[];
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
  action: 'CAPTURED' | 'FAILED' | 'ESCALATED' | 'ALREADY_FINAL' | 'RECONCILIATION_REQUIRED';
  message: string;
  providerPaymentId?: string;
}

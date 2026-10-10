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
  }[];
  receipt?: {
    transactionId: string;
    amount: number;
    status: string;
    verifiedAt: string;
  };
}

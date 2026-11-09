export type SellerSettlementStatus = 'ELIGIBLE' | 'SCHEDULED' | 'PROCESSING' | 'PAID' | 'FAILED';

export type RiderPayoutStatus =
  | 'EARNING_CREATED'
  | 'EARNING_FROZEN'
  | 'PAYABLE'
  | 'PAYOUT_PENDING'
  | 'PROCESSING'
  | 'PAID'
  | 'FAILED'
  | 'REVERSED';

export interface OrderSettlementAllocation {
  id: string;
  orderId: string;
  merchantId: string;
  riderId?: string;
  tripId?: string;
  journalBatchId: string;
  orderTotal: number;
  grossGmv: number;
  sellerGoodsTaxable: number;
  sellerGoodsGst: number;
  platformCommission: number;
  commissionGst: number;
  gstTcsAmount: number;
  sellerTdsAmount: number;
  storeDelayPenalty: number;
  netSellerPayable: number;
  customerDeliveryFee: number;
  customerHandlingFee: number;
  grossRiderFare: number;
  customerTip: number;
  riderTdsAmount: number;
  netRiderPayable: number;
  platformSubsidy: number;
  status: 'ALLOCATED' | 'SETTLED' | 'REVERSED';
  allocatedAt: string;
}

export interface SellerSettlementStatement {
  merchantId: string;
  merchantName: string;
  panNumber?: string;
  panStatus?: string;
  gstin?: string;
  commissionRatePercent: number;
  bankDetails: {
    accountNumber: string;
    ifsc: string;
    accountHolder?: string;
    bankName?: string;
    verified: boolean;
  };
  totalGrossGmv: number;
  totalCommission: number;
  totalCommissionGst: number;
  totalGstTcs: number;
  totalSellerTds: number;
  totalPenalties: number;
  totalNetPayable: number;
  settledAmount: number;
  outstandingBalance: number;
  orders: {
    orderId: string;
    orderNumber: string;
    orderDate: string;
    grossGmv: number;
    commission: number;
    gstTcs: number;
    tds: number;
    netPayable: number;
  }[];
}

export interface RiderEarningsStatement {
  riderId: string;
  riderName: string;
  panNumber?: string;
  panStatus?: string;
  kycStatus: string;
  walletBalance: number;
  floatingCashBalance: number;
  floatingCashLimit: number;
  isDispatchBlocked: boolean;
  upiVpa?: string;
  bankDetails?: {
    accountNumber?: string;
    ifsc?: string;
  };
  totalGrossEarnings: number;
  totalTips: number;
  totalTdsWithheld: number;
  totalNetEarnings: number;
  totalPaidOut: number;
  trips: {
    tripId: string;
    orderId: string;
    deliveredAt: string;
    baseFare: number;
    distanceFare: number;
    surgeFare: number;
    waitCompensation: number;
    customerTip: number;
    tdsWithheld: number;
    netPayout: number;
  }[];
}

export interface PayoutResult {
  payoutId: string;
  payoutReference: string;
  actorId: string;
  amount: number;
  status: string;
  utrNumber?: string;
  journalBatchId?: string;
  isDuplicate?: boolean;
  failureReason?: string;
}

const ALLOWED_SELLER_SETTLEMENT_TRANSITIONS: Record<SellerSettlementStatus, ReadonlySet<SellerSettlementStatus>> = {
  ELIGIBLE: new Set(['SCHEDULED', 'PROCESSING', 'PAID', 'FAILED']),
  SCHEDULED: new Set(['PROCESSING', 'PAID', 'FAILED', 'ELIGIBLE']),
  PROCESSING: new Set(['PAID', 'FAILED']),
  PAID: new Set([]), // Terminal
  FAILED: new Set(['ELIGIBLE', 'SCHEDULED']), // Can be re-queued after fixing bank info
};

export function validateSellerSettlementTransition(
  from: SellerSettlementStatus,
  to: SellerSettlementStatus
): { valid: boolean; isDuplicate: boolean; error?: string } {
  if (from === to) return { valid: true, isDuplicate: true };
  if (from === 'PAID') {
    return { valid: false, isDuplicate: false, error: 'INVALID_TRANSITION: Seller settlement has already been PAID.' };
  }
  const allowed = ALLOWED_SELLER_SETTLEMENT_TRANSITIONS[from];
  if (allowed && allowed.has(to)) {
    return { valid: true, isDuplicate: false };
  }
  return { valid: false, isDuplicate: false, error: `INVALID_TRANSITION: Cannot transition from ${from} to ${to}.` };
}

const ALLOWED_RIDER_PAYOUT_TRANSITIONS: Record<RiderPayoutStatus, ReadonlySet<RiderPayoutStatus>> = {
  EARNING_CREATED: new Set(['EARNING_FROZEN']),
  EARNING_FROZEN: new Set(['PAYABLE']),
  PAYABLE: new Set(['PAYOUT_PENDING', 'PROCESSING']),
  PAYOUT_PENDING: new Set(['PROCESSING', 'PAID', 'FAILED']),
  PROCESSING: new Set(['PAID', 'FAILED']),
  PAID: new Set(['REVERSED']),
  FAILED: new Set(['PAYABLE', 'REVERSED']),
  REVERSED: new Set([]), // Terminal
};

export function validateRiderPayoutTransition(
  from: RiderPayoutStatus,
  to: RiderPayoutStatus
): { valid: boolean; isDuplicate: boolean; error?: string } {
  if (from === to) return { valid: true, isDuplicate: true };
  if (from === 'REVERSED') {
    return { valid: false, isDuplicate: false, error: 'INVALID_TRANSITION: Payout is in terminal REVERSED status.' };
  }
  const allowed = ALLOWED_RIDER_PAYOUT_TRANSITIONS[from];
  if (allowed && allowed.has(to)) {
    return { valid: true, isDuplicate: false };
  }
  return { valid: false, isDuplicate: false, error: `INVALID_TRANSITION: Cannot transition from ${from} to ${to}.` };
}

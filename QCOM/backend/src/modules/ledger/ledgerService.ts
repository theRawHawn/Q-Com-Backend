import pg from 'pg';
import crypto from 'crypto';
import BigNumber from 'bignumber.js';
import { getPool, transaction } from '../../database/connection.js';
import { toDecimal, roundCurrency, add, subtract } from '../pricing/money.js';

export interface LedgerPaymentEntry {
  orderId: string;
  merchantId: string;
  grossAmount: number;
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  deliveryFee: number;
  handlingFee: number;
  client?: pg.PoolClient;
}

export interface FulfillmentAllocationLedgerParams {
  orderId: string;
  merchantId: string;
  riderId?: string;
  orderTotal: number;
  netSellerPayable: number;
  grossRiderFare: number;
  netRiderPayable: number;
  riderTdsAmount: number;
  platformCommission: number;
  commissionGst: number;
  customerDeliveryFee: number;
  deliveryFeeGst: number;
  customerHandlingFee: number;
  handlingFeeGst: number;
  storeDelayPenalty: number;
  gstTcsAmount: number;
  sellerTdsAmount: number;
  platformDiscountSubsidy?: number;
  client?: pg.PoolClient;
}

interface NormalizedBatchLine {
  account: string;
  side: 'DEBIT' | 'CREDIT';
  amountStr: string;
  amount: number;
  orderId: string | null;
  merchantId: string | null;
  riderId: string | null;
  narration: string;
}

function assertPositiveMoney(value: number | string, fieldName: string): number {
  const bn = toDecimal(value);
  if (bn.lte(0)) {
    throw new Error(`INVALID_FINANCIAL_AMOUNT: ${fieldName} must be greater than zero (got ${value}).`);
  }
  return Number(roundCurrency(bn));
}

function assertNonNegativeMoney(value: number | string, fieldName: string): number {
  const bn = toDecimal(value);
  if (bn.lt(0)) {
    throw new Error(`INVALID_FINANCIAL_AMOUNT: ${fieldName} cannot be negative (got ${value}).`);
  }
  return Number(roundCurrency(bn));
}

export function isCodPaymentMethod(method?: string | null): boolean {
  if (!method) return false;
  const normalized = String(method).trim().toLowerCase();
  return (
    normalized === 'pay on delivery' ||
    normalized === 'cod' ||
    normalized === 'cash on delivery' ||
    normalized === 'cash_on_delivery'
  );
}

function computeCanonicalPayloadHash(
  transactionType: string,
  lines: { account: string; side: string; amountStr: string }[]
): string {
  const canonical = lines
    .map((l) => `${l.account}:${l.side}:${l.amountStr}`)
    .sort()
    .join(';');
  return crypto
    .createHash('sha256')
    .update(`${transactionType}|${canonical}`)
    .digest('hex');
}

export class LedgerService {
  /**
   * Aggregates same-(account, side) legs inside a single journal batch,
   * enforces exact Debit == Credit balance, atomically claims transaction_reference
   * in ledger_journal_batches, and rejects payload mismatches on replay.
   */
  public async postJournalBatch(params: {
    txRef: string;
    transactionType: string;
    lines: {
      account: string;
      side: 'DEBIT' | 'CREDIT';
      amount: number | string | BigNumber;
      narration: string;
      orderId?: string | null;
      merchantId?: string | null;
      riderId?: string | null;
    }[];
    client?: pg.PoolClient;
  }): Promise<string> {
    const { txRef, transactionType, client } = params;

    // Aggregate legitimate multiple lines targeting the same (account, side) in one batch
    // so uq_gl_ref_account_side is preserved cleanly while retaining exact sums.
    const grouped = new Map<
      string,
      {
        account: string;
        side: 'DEBIT' | 'CREDIT';
        amountBn: BigNumber;
        orderId: string | null;
        merchantId: string | null;
        riderId: string | null;
        narrations: string[];
      }
    >();

    for (const rawLine of params.lines) {
      const bn = toDecimal(rawLine.amount);
      if (bn.lte(0)) continue;
      const key = `${rawLine.account}|${rawLine.side}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.amountBn = existing.amountBn.plus(bn);
        existing.orderId = existing.orderId || rawLine.orderId || null;
        existing.merchantId = existing.merchantId || rawLine.merchantId || null;
        existing.riderId = existing.riderId || rawLine.riderId || null;
        if (rawLine.narration && !existing.narrations.includes(rawLine.narration)) {
          existing.narrations.push(rawLine.narration);
        }
      } else {
        grouped.set(key, {
          account: rawLine.account,
          side: rawLine.side,
          amountBn: bn,
          orderId: rawLine.orderId || null,
          merchantId: rawLine.merchantId || null,
          riderId: rawLine.riderId || null,
          narrations: rawLine.narration ? [rawLine.narration] : [],
        });
      }
    }

    const normalized: NormalizedBatchLine[] = [];
    let debitSumBn = new BigNumber(0);
    let creditSumBn = new BigNumber(0);

    for (const item of grouped.values()) {
      const amountStr = roundCurrency(item.amountBn);
      const amountNum = Number(amountStr);
      if (amountNum <= 0) continue;
      if (item.side === 'DEBIT') {
        debitSumBn = debitSumBn.plus(toDecimal(amountStr));
      } else {
        creditSumBn = creditSumBn.plus(toDecimal(amountStr));
      }
      normalized.push({
        account: item.account,
        side: item.side,
        amountStr,
        amount: amountNum,
        orderId: item.orderId,
        merchantId: item.merchantId,
        riderId: item.riderId,
        narration: item.narrations.join(' | '),
      });
    }

    if (normalized.length === 0) {
      throw new Error(`LEDGER_UNBALANCED: Journal batch '${txRef}' has zero positive entries.`);
    }

    const totalDebitsStr = roundCurrency(debitSumBn);
    const totalCreditsStr = roundCurrency(creditSumBn);
    if (!toDecimal(totalDebitsStr).eq(toDecimal(totalCreditsStr))) {
      throw new Error(
        `LEDGER_UNBALANCED: Journal batch '${txRef}' debits (${totalDebitsStr}) do not equal credits (${totalCreditsStr}).`
      );
    }

    const payloadHash = computeCanonicalPayloadHash(transactionType, normalized);

    const executeInTx = async (txClient: pg.PoolClient): Promise<string> => {
      // Check existing batch registry first (or unbackfilled legacy general_ledger_entries in pg-mem)
      const existingBatchRes = await txClient.query(
        `SELECT journal_batch_id, transaction_type, payload_hash
         FROM ledger_journal_batches
         WHERE transaction_reference = $1
         LIMIT 1`,
        [txRef]
      );

      if (existingBatchRes.rows.length > 0) {
        return await this.verifyExistingBatch(txClient, txRef, transactionType, payloadHash, existingBatchRes.rows[0]);
      }

      // Legacy fallback: check if general_ledger_entries already contains unbackfilled entries for txRef
      const legacyEntriesRes = await txClient.query(
        `SELECT journal_batch_id, transaction_type, account_code, entry_side, amount
         FROM general_ledger_entries
         WHERE transaction_reference = $1`,
        [txRef]
      );
      if (legacyEntriesRes.rows.length > 0) {
        const legacyHash = computeCanonicalPayloadHash(
          String(legacyEntriesRes.rows[0].transaction_type),
          legacyEntriesRes.rows.map((r: any) => ({
            account: String(r.account_code),
            side: String(r.entry_side),
            amountStr: roundCurrency(r.amount),
          }))
        );
        if (legacyEntriesRes.rows[0].transaction_type !== transactionType || legacyHash !== payloadHash) {
          throw new Error(
            `LEDGER_TX_REF_CONFLICT: Transaction reference '${txRef}' already exists with a different payload.`
          );
        }
        return legacyEntriesRes.rows[0].journal_batch_id;
      }

      // Atomic batch claim: ON CONFLICT DO NOTHING ensures concurrent writers never partially interleave legs
      const proposedBatchId = crypto.randomUUID();
      const claimRes = await txClient.query(
        `INSERT INTO ledger_journal_batches (
           transaction_reference, journal_batch_id, transaction_type,
           payload_hash, total_debits, total_credits
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (transaction_reference) DO NOTHING
         RETURNING journal_batch_id`,
        [txRef, proposedBatchId, transactionType, payloadHash, totalDebitsStr, totalCreditsStr]
      );

      if (claimRes.rows.length === 0) {
        const racerRes = await txClient.query(
          `SELECT journal_batch_id, transaction_type, payload_hash
           FROM ledger_journal_batches
           WHERE transaction_reference = $1
           LIMIT 1`,
          [txRef]
        );
        if (racerRes.rows.length === 0) {
          throw new Error(`LEDGER_TX_REF_CONFLICT: Failed to resolve concurrent journal batch '${txRef}'.`);
        }
        return await this.verifyExistingBatch(txClient, txRef, transactionType, payloadHash, racerRes.rows[0]);
      }

      // Winner inserts ALL batch entries atomically WITHOUT ON CONFLICT DO NOTHING
      for (const line of normalized) {
        await txClient.query(
          `INSERT INTO general_ledger_entries (
             journal_batch_id, transaction_reference, transaction_type,
             account_code, entry_side, amount, currency,
             order_id, merchant_id, rider_id, narration
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'INR', $7, $8, $9, $10)`,
          [
            proposedBatchId,
            txRef,
            transactionType,
            line.account,
            line.side,
            line.amountStr,
            line.orderId,
            line.merchantId,
            line.riderId,
            line.narration,
          ]
        );
      }

      return proposedBatchId;
    };

    if (client) {
      return executeInTx(client);
    }
    return transaction(executeInTx);
  }

  private async verifyExistingBatch(
    txClient: pg.PoolClient,
    txRef: string,
    transactionType: string,
    expectedHash: string,
    existingBatch: { journal_batch_id: string; transaction_type: string; payload_hash: string }
  ): Promise<string> {
    if (existingBatch.payload_hash === 'LEGACY_BACKFILL') {
      const legacyRows = await txClient.query(
        `SELECT transaction_type, account_code, entry_side, amount
         FROM general_ledger_entries
         WHERE transaction_reference = $1`,
        [txRef]
      );
      const legacyHash = computeCanonicalPayloadHash(
        String(existingBatch.transaction_type),
        legacyRows.rows.map((r: any) => ({
          account: String(r.account_code),
          side: String(r.entry_side),
          amountStr: roundCurrency(r.amount),
        }))
      );
      if (existingBatch.transaction_type !== transactionType || legacyHash !== expectedHash) {
        throw new Error(
          `LEDGER_TX_REF_CONFLICT: Transaction reference '${txRef}' already committed with different financial payload.`
        );
      }
      return existingBatch.journal_batch_id;
    }

    if (existingBatch.transaction_type !== transactionType || existingBatch.payload_hash !== expectedHash) {
      throw new Error(
        `LEDGER_TX_REF_CONFLICT: Transaction reference '${txRef}' already committed with different financial payload.`
      );
    }

    return existingBatch.journal_batch_id;
  }

  /**
   * Batch A: Customer Online Payment Capture
   * Dr 1010 Cash at Gateway (Escrow), Cr 2010 Customer Funds Held in Escrow
   */
  public async recordOrderPayment(entry: LedgerPaymentEntry): Promise<string> {
    const txRef = `TX_PAY_${entry.orderId}`;
    const grossAmount = assertPositiveMoney(entry.grossAmount, 'grossAmount');

    return this.postJournalBatch({
      txRef,
      transactionType: 'CUSTOMER_PAYMENT',
      client: entry.client,
      lines: [
        {
          account: '1010',
          side: 'DEBIT',
          amount: grossAmount,
          orderId: entry.orderId,
          merchantId: entry.merchantId,
          narration: `Customer payment escrow for order ${entry.orderId}`,
        },
        {
          account: '2010',
          side: 'CREDIT',
          amount: grossAmount,
          orderId: entry.orderId,
          merchantId: entry.merchantId,
          narration: `Escrow liability for order ${entry.orderId}`,
        },
      ],
    });
  }

  /**
   * Batch B: Cash on Delivery Collection
   * Dr 1030 Floating Cash in Hands of Riders (COD), Cr 2010 Customer Funds Held in Escrow
   */
  public async recordCodCollection(params: {
    orderId: string;
    merchantId: string;
    riderId: string;
    amount: number;
    client?: pg.PoolClient;
  }): Promise<string> {
    const txRef = `TX_COD_COLLECT_${params.orderId}`;
    const amount = assertPositiveMoney(params.amount, 'codAmount');

    return this.postJournalBatch({
      txRef,
      transactionType: 'COD_COLLECTION',
      client: params.client,
      lines: [
        {
          account: '1030',
          side: 'DEBIT',
          amount,
          orderId: params.orderId,
          merchantId: params.merchantId,
          riderId: params.riderId,
          narration: `COD physical collection by rider for order ${params.orderId}`,
        },
        {
          account: '2010',
          side: 'CREDIT',
          amount,
          orderId: params.orderId,
          merchantId: params.merchantId,
          riderId: params.riderId,
          narration: `Customer liability satisfied via COD for order ${params.orderId}`,
        },
      ],
    });
  }

  /**
   * Batches C through I: Order Fulfillment Financial Allocation (Atomic Double-Entry Batch)
   * Dr 2010 Customer Escrow (Order Total), Dr 5010 Rider Logistics Expense (Gross Rider Fare)
   * Cr 2020 Merchant Payable, Cr 2030 Rider Wallet, Cr 2060 Rider TDS, Cr 4010 Commission,
   * Cr 4020 Delivery Fee, Cr 4030 Handling Fee & Penalty, Cr 2070 Output GST, Cr 2040 GST-TCS, Cr 2050 Seller TDS
   * Total Debits == Total Credits == Order Total + Gross Rider Fare
   */
  public async recordOrderFulfillmentAllocation(params: FulfillmentAllocationLedgerParams): Promise<string> {
    const txRef = `TX_FULFILL_${params.orderId}`;

    const orderTotal = assertPositiveMoney(params.orderTotal, 'orderTotal');
    const grossRiderFare = assertNonNegativeMoney(params.grossRiderFare, 'grossRiderFare');
    const netSellerPayable = assertNonNegativeMoney(params.netSellerPayable, 'netSellerPayable');
    const netRiderPayable = assertNonNegativeMoney(params.netRiderPayable, 'netRiderPayable');
    const riderTdsAmount = assertNonNegativeMoney(params.riderTdsAmount, 'riderTdsAmount');
    const platformCommission = assertNonNegativeMoney(params.platformCommission, 'platformCommission');
    const commissionGst = assertNonNegativeMoney(params.commissionGst, 'commissionGst');
    const customerDeliveryFee = assertNonNegativeMoney(params.customerDeliveryFee, 'customerDeliveryFee');
    const deliveryFeeGst = assertNonNegativeMoney(params.deliveryFeeGst, 'deliveryFeeGst');
    const customerHandlingFee = assertNonNegativeMoney(params.customerHandlingFee, 'customerHandlingFee');
    const handlingFeeGst = assertNonNegativeMoney(params.handlingFeeGst, 'handlingFeeGst');
    const storeDelayPenalty = assertNonNegativeMoney(params.storeDelayPenalty, 'storeDelayPenalty');
    const gstTcsAmount = assertNonNegativeMoney(params.gstTcsAmount, 'gstTcsAmount');
    const sellerTdsAmount = assertNonNegativeMoney(params.sellerTdsAmount, 'sellerTdsAmount');
    const platformDiscountSubsidy = assertNonNegativeMoney(params.platformDiscountSubsidy || 0, 'platformDiscountSubsidy');

    const totalFeeGst = Number(roundCurrency(add(commissionGst, deliveryFeeGst, handlingFeeGst)));
    const totalPlatformCharges = Number(roundCurrency(add(customerHandlingFee, storeDelayPenalty)));

    const entries: {
      account: string;
      side: 'DEBIT' | 'CREDIT';
      amount: number;
      narration: string;
      orderId?: string;
      merchantId?: string;
      riderId?: string;
    }[] = [];

    // 1. Debit Customer Escrow Liability
    entries.push({
      account: '2010',
      side: 'DEBIT',
      amount: orderTotal,
      narration: `Release customer escrow liability upon order fulfillment for ${params.orderId}`,
      orderId: params.orderId,
      merchantId: params.merchantId,
      riderId: params.riderId,
    });

    // 1B. Debit Platform Promotional Subsidy Expense (COA 5040) when platform funds item discounts
    if (platformDiscountSubsidy > 0) {
      entries.push({
        account: '5040',
        side: 'DEBIT',
        amount: platformDiscountSubsidy,
        narration: `Platform-funded coupon/promotion subsidy reimbursed to merchant for order ${params.orderId}`,
        orderId: params.orderId,
        merchantId: params.merchantId,
      });
    }

    // 2. Debit Rider Logistics Expense
    if (grossRiderFare > 0) {
      entries.push({
        account: '5010',
        side: 'DEBIT',
        amount: grossRiderFare,
        narration: `Logistics expense recognized for delivery of order ${params.orderId}`,
        orderId: params.orderId,
        merchantId: params.merchantId,
        riderId: params.riderId,
      });
    }

    // 3. Credit Merchant Accounts Payable
    if (netSellerPayable > 0) {
      entries.push({
        account: '2020',
        side: 'CREDIT',
        amount: netSellerPayable,
        narration: `Net payable allocated to merchant for order ${params.orderId}`,
        orderId: params.orderId,
        merchantId: params.merchantId,
      });
    }

    // 4. Credit Delivery Partner Wallet Payable
    if (netRiderPayable > 0) {
      entries.push({
        account: '2030',
        side: 'CREDIT',
        amount: netRiderPayable,
        narration: `Net fare and tips payable to delivery partner for order ${params.orderId}`,
        orderId: params.orderId,
        riderId: params.riderId,
      });
    }

    // 5. Credit Logistics Withholding Payable (Sec 393 / 194-C)
    if (riderTdsAmount > 0) {
      entries.push({
        account: '2060',
        side: 'CREDIT',
        amount: riderTdsAmount,
        narration: `TDS withheld on rider logistics fare under Section 393 for order ${params.orderId}`,
        orderId: params.orderId,
        riderId: params.riderId,
      });
    }

    // 6. Credit Marketplace Commission Revenue (SAC 9983)
    if (platformCommission > 0) {
      entries.push({
        account: '4010',
        side: 'CREDIT',
        amount: platformCommission,
        narration: `Marketplace commission earned under SAC 9983 on order ${params.orderId}`,
        orderId: params.orderId,
        merchantId: params.merchantId,
      });
    }

    // 7. Credit Customer Delivery Fee Revenue (SAC 9968)
    if (customerDeliveryFee > 0) {
      entries.push({
        account: '4020',
        side: 'CREDIT',
        amount: customerDeliveryFee,
        narration: `Customer logistics fee revenue recognized under SAC 9968 for order ${params.orderId}`,
        orderId: params.orderId,
      });
    }

    // 8. Credit Convenience, Handling & Store Delay Fees (SAC 9985)
    if (totalPlatformCharges > 0) {
      entries.push({
        account: '4030',
        side: 'CREDIT',
        amount: totalPlatformCharges,
        narration: `Platform handling fee and merchant delay compensation for order ${params.orderId}`,
        orderId: params.orderId,
        merchantId: params.merchantId,
      });
    }

    // 9. Credit Output GST Liability on Platform Fees
    if (totalFeeGst > 0) {
      entries.push({
        account: '2070',
        side: 'CREDIT',
        amount: totalFeeGst,
        narration: `Output GST liability on platform fees (commission, delivery, handling) for order ${params.orderId}`,
        orderId: params.orderId,
      });
    }

    // 10. Credit GST-TCS Section 52 Payable
    if (gstTcsAmount > 0) {
      entries.push({
        account: '2040',
        side: 'CREDIT',
        amount: gstTcsAmount,
        narration: `Section 52 GST-TCS collected for order ${params.orderId}`,
        orderId: params.orderId,
        merchantId: params.merchantId,
      });
    }

    // 11. Credit Income-Tax Withholding Payable (Sec 393 / 194-O)
    if (sellerTdsAmount > 0) {
      entries.push({
        account: '2050',
        side: 'CREDIT',
        amount: sellerTdsAmount,
        narration: `Section 393 e-commerce TDS withheld from merchant for order ${params.orderId}`,
        orderId: params.orderId,
        merchantId: params.merchantId,
      });
    }

    // Enforce exact mathematical Debit == Credit equality with BigNumber
    let totalDebitsBn = entries
      .filter((e) => e.side === 'DEBIT')
      .reduce((sum, e) => sum.plus(toDecimal(e.amount)), new BigNumber(0));
    let totalCreditsBn = entries
      .filter((e) => e.side === 'CREDIT')
      .reduce((sum, e) => sum.plus(toDecimal(e.amount)), new BigNumber(0));

    const diffBn = totalDebitsBn.minus(totalCreditsBn);
    if (diffBn.abs().gt(0.05)) {
      throw new Error(
        `LEDGER_UNBALANCED: Fulfillment journal batch is unbalanced. Debits: ${roundCurrency(totalDebitsBn)}, Credits: ${roundCurrency(totalCreditsBn)}, Diff: ${roundCurrency(diffBn)}`
      );
    } else if (!diffBn.isZero()) {
      // Absorb fractional rounding difference (<= ₹0.05) into convenience/handling revenue (4030) or merchant payable
      const adjEntry =
        entries.find((e) => e.account === '4030' && toDecimal(e.amount).plus(diffBn).gt(0)) ||
        entries.find((e) => e.account === '2020' && toDecimal(e.amount).plus(diffBn).gt(0));
      if (adjEntry) {
        adjEntry.amount = Number(roundCurrency(toDecimal(adjEntry.amount).plus(diffBn)));
      }
      totalDebitsBn = entries
        .filter((e) => e.side === 'DEBIT')
        .reduce((sum, e) => sum.plus(toDecimal(e.amount)), new BigNumber(0));
      totalCreditsBn = entries
        .filter((e) => e.side === 'CREDIT')
        .reduce((sum, e) => sum.plus(toDecimal(e.amount)), new BigNumber(0));
      if (!totalDebitsBn.eq(totalCreditsBn)) {
        throw new Error(
          `LEDGER_UNBALANCED: Fulfillment rounding adjustment failed to balance batch (${roundCurrency(totalDebitsBn)} != ${roundCurrency(totalCreditsBn)}).`
        );
      }
    }

    return this.postJournalBatch({
      txRef,
      transactionType: 'ORDER_FULFILLMENT',
      lines: entries,
      client: params.client,
    });
  }

  /**
   * Batch J: Merchant Settlement Payout Disbursed
   * Dr 2020 Merchant Accounts Payable, Cr 1020 Bank Operating Account
   */
  public async recordMerchantSettlementPayout(params: {
    merchantId: string;
    amount: number;
    payoutReference: string;
    utrNumber?: string;
    client?: pg.PoolClient;
  }): Promise<string> {
    const txRef = `TX_MERCH_PAYOUT_${params.payoutReference}`;
    const amount = assertPositiveMoney(params.amount, 'payoutAmount');

    return this.postJournalBatch({
      txRef,
      transactionType: 'MERCHANT_SETTLEMENT',
      client: params.client,
      lines: [
        {
          account: '2020',
          side: 'DEBIT',
          amount,
          merchantId: params.merchantId,
          narration: `Disbursement of merchant payable via bank transfer (Ref: ${params.payoutReference}, UTR: ${params.utrNumber || 'PENDING'})`,
        },
        {
          account: '1020',
          side: 'CREDIT',
          amount,
          merchantId: params.merchantId,
          narration: `Bank operating account debit for merchant settlement ${params.payoutReference}`,
        },
      ],
    });
  }

  /**
   * Batch L: Rider Payout Disbursed
   * Dr 2030 Delivery Partner Wallet Payable, Cr 1020 Bank Operating Account
   */
  public async recordRiderPayout(params: {
    riderId: string;
    amount: number;
    payoutReference: string;
    utrNumber?: string;
    client?: pg.PoolClient;
  }): Promise<string> {
    const txRef = `TX_RIDER_PAYOUT_${params.payoutReference}`;
    const amount = assertPositiveMoney(params.amount, 'riderPayoutAmount');

    return this.postJournalBatch({
      txRef,
      transactionType: 'RIDER_PAYOUT',
      client: params.client,
      lines: [
        {
          account: '2030',
          side: 'DEBIT',
          amount,
          riderId: params.riderId,
          narration: `Disbursement of rider wallet earnings via UPI/IMPS (Ref: ${params.payoutReference}, UTR: ${params.utrNumber || 'PENDING'})`,
        },
        {
          account: '1020',
          side: 'CREDIT',
          amount,
          riderId: params.riderId,
          narration: `Bank operating account disbursement for rider payout ${params.payoutReference}`,
        },
      ],
    });
  }

  /**
   * Batch N: Verified Rider COD Remittance Clearance (with optional Excess Suspense Split)
   * Standard exact/shortage clearance:
   *   Dr 1020 Bank Operating Account (verifiedCashAmount)
   *   Cr 1030 Floating Cash in Hands of Riders (clearedLiabilityAmount)
   * When excess cash is physically received above rider liability/submitted target:
   *   Dr 1020 Bank Operating Account (verifiedCashAmount)
   *   Cr 1030 Floating Cash in Hands of Riders (clearedLiabilityAmount)
   *   Cr 2080 Unidentified / Excess COD Cash Suspense (excessAmount)
   */
  public async recordRiderCodRemittance(params: {
    riderId: string;
    amount: number;
    clearedLiabilityAmount?: number;
    excessAmount?: number;
    reference: string;
    orderId?: string | null;
    client?: pg.PoolClient;
  }): Promise<string> {
    const txRef = `TX_COD_REMIT_${params.reference}`;
    const verifiedCashAmount = assertPositiveMoney(params.amount, 'remittanceAmount');
    const excessAmount = assertNonNegativeMoney(params.excessAmount ?? 0, 'excessAmount');
    const clearedLiabilityAmount =
      params.clearedLiabilityAmount !== undefined
        ? assertNonNegativeMoney(params.clearedLiabilityAmount, 'clearedLiabilityAmount')
        : Number(roundCurrency(subtract(verifiedCashAmount, excessAmount)));

    const sumCreditsBn = add(clearedLiabilityAmount, excessAmount);
    if (!toDecimal(verifiedCashAmount).eq(sumCreditsBn)) {
      throw new Error(
        `LEDGER_UNBALANCED: Remittance debit ${verifiedCashAmount} != credits ${roundCurrency(sumCreditsBn)}`
      );
    }

    const lines: {
      account: string;
      side: 'DEBIT' | 'CREDIT';
      amount: number;
      narration: string;
      orderId?: string | null;
      riderId?: string | null;
    }[] = [
      {
        account: '1020',
        side: 'DEBIT',
        amount: verifiedCashAmount,
        riderId: params.riderId,
        orderId: params.orderId || null,
        narration: `Bank/Vault operating receipt for verified COD remittance (Ref: ${params.reference})`,
      },
    ];

    if (clearedLiabilityAmount > 0) {
      lines.push({
        account: '1030',
        side: 'CREDIT',
        amount: clearedLiabilityAmount,
        riderId: params.riderId,
        orderId: params.orderId || null,
        narration: `Clearance of verified rider COD floating cash liability (Ref: ${params.reference}, Rider: ${params.riderId})`,
      });
    }

    if (excessAmount > 0) {
      lines.push({
        account: '2080',
        side: 'CREDIT',
        amount: excessAmount,
        riderId: params.riderId,
        orderId: params.orderId || null,
        narration: `Excess COD cash held in suspense awaiting investigation (Ref: ${params.reference}, Rider: ${params.riderId})`,
      });
    }

    return this.postJournalBatch({
      txRef,
      transactionType: 'COD_REMITTANCE',
      client: params.client,
      lines,
    });
  }

  /**
   * Batch N-REV: Reversal of Verified COD Remittance (preserves original batch, posts offsetting entries)
   */
  public async recordCodRemittanceReversal(params: {
    riderId: string;
    verifiedAmount: number;
    clearedLiabilityAmount: number;
    excessAmount?: number;
    reference: string;
    reason: string;
    client?: pg.PoolClient;
  }): Promise<string> {
    const txRef = `TX_COD_REV_${params.reference}`;
    const verifiedAmount = assertPositiveMoney(params.verifiedAmount, 'verifiedAmount');
    const excessAmount = assertNonNegativeMoney(params.excessAmount ?? 0, 'excessAmount');
    const clearedLiabilityAmount = assertNonNegativeMoney(params.clearedLiabilityAmount, 'clearedLiabilityAmount');

    if (!toDecimal(verifiedAmount).eq(add(clearedLiabilityAmount, excessAmount))) {
      throw new Error('LEDGER_UNBALANCED: Remittance reversal amounts do not balance.');
    }

    const lines: {
      account: string;
      side: 'DEBIT' | 'CREDIT';
      amount: number;
      narration: string;
      riderId?: string | null;
    }[] = [];

    if (clearedLiabilityAmount > 0) {
      lines.push({
        account: '1030',
        side: 'DEBIT',
        amount: clearedLiabilityAmount,
        riderId: params.riderId,
        narration: `Reversal of verified COD remittance restoring rider cash liability (Ref: ${params.reference}, Reason: ${params.reason})`,
      });
    }
    if (excessAmount > 0) {
      lines.push({
        account: '2080',
        side: 'DEBIT',
        amount: excessAmount,
        riderId: params.riderId,
        narration: `Reversal of excess COD suspense credit on remittance reversal (Ref: ${params.reference})`,
      });
    }
    lines.push({
      account: '1020',
      side: 'CREDIT',
      amount: verifiedAmount,
      riderId: params.riderId,
      narration: `Bank/Vault reversal for COD remittance ${params.reference} (${params.reason})`,
    });

    return this.postJournalBatch({
      txRef,
      transactionType: 'COD_REVERSAL',
      client: params.client,
      lines,
    });
  }

  /**
   * Batch N-DISP: COD Shortage / Excess Dispute Accounting Resolution
   */
  public async recordCodDisputeResolution(params: {
    riderId: string;
    disputeNumber: string;
    resolutionType:
      | 'RECOVERED_CASH'
      | 'RECOVERED_FROM_WALLET'
      | 'ESCALATED_TO_RECEIVABLE'
      | 'RECEIVABLE_COLLECTED'
      | 'WRITTEN_OFF'
      | 'EXCESS_RETURNED'
      | 'EXCESS_ALLOCATED_TO_COLLECTION';
    amount: number;
    fromReceivable?: boolean;
    orderId?: string | null;
    reason: string;
    client?: pg.PoolClient;
  }): Promise<string> {
    const txRef = `TX_COD_DISP_${params.disputeNumber}_${params.resolutionType}`;
    const amount = assertPositiveMoney(params.amount, 'disputeResolutionAmount');
    const sourceAssetAccount = params.fromReceivable ? '1050' : '1030';

    let debitAccount: string;
    let creditAccount: string;
    let transactionType = 'COD_ADJUSTMENT';

    switch (params.resolutionType) {
      case 'RECOVERED_CASH':
      case 'RECEIVABLE_COLLECTED':
        debitAccount = '1020';
        creditAccount = params.resolutionType === 'RECEIVABLE_COLLECTED' ? '1050' : sourceAssetAccount;
        transactionType = 'COD_REMITTANCE';
        break;
      case 'RECOVERED_FROM_WALLET':
        debitAccount = '2030';
        creditAccount = sourceAssetAccount;
        transactionType = 'COD_SHORTAGE';
        break;
      case 'ESCALATED_TO_RECEIVABLE':
        debitAccount = '1050';
        creditAccount = '1030';
        transactionType = 'COD_SHORTAGE';
        break;
      case 'WRITTEN_OFF':
        debitAccount = '5030';
        creditAccount = sourceAssetAccount;
        transactionType = 'COD_SHORTAGE';
        break;
      case 'EXCESS_RETURNED':
        debitAccount = '2080';
        creditAccount = '1020';
        transactionType = 'COD_EXCESS';
        break;
      case 'EXCESS_ALLOCATED_TO_COLLECTION':
        debitAccount = '2080';
        creditAccount = '1030';
        transactionType = 'COD_EXCESS';
        break;
      default:
        throw new Error(`UNSUPPORTED_DISPUTE_RESOLUTION: ${params.resolutionType}`);
    }

    return this.postJournalBatch({
      txRef,
      transactionType,
      client: params.client,
      lines: [
        {
          account: debitAccount,
          side: 'DEBIT',
          amount,
          riderId: params.riderId,
          orderId: params.orderId || null,
          narration: `COD dispute ${params.disputeNumber} (${params.resolutionType}): ${params.reason}`,
        },
        {
          account: creditAccount,
          side: 'CREDIT',
          amount,
          riderId: params.riderId,
          orderId: params.orderId || null,
          narration: `COD dispute ${params.disputeNumber} settlement leg (${params.resolutionType}): ${params.reason}`,
        },
      ],
    });
  }

  /**
   * Batch K / M: Payout Failure Reversal (after bank confirmation was previously recorded)
   * Dr 1020 Bank Operating Account, Cr 2020 Merchant Payable / Cr 2030 Rider Wallet
   */
  public async recordPayoutFailureReversal(params: {
    type: 'MERCHANT' | 'RIDER';
    actorId: string;
    amount: number;
    reference: string;
    client?: pg.PoolClient;
  }): Promise<string> {
    const txRef = `TX_PAYOUT_REV_${params.reference}`;
    const amount = assertPositiveMoney(params.amount, 'reversalAmount');
    const targetAccount = params.type === 'MERCHANT' ? '2020' : '2030';
    const merchantId = params.type === 'MERCHANT' ? params.actorId : null;
    const riderId = params.type === 'RIDER' ? params.actorId : null;

    return this.postJournalBatch({
      txRef,
      transactionType: 'ADJUSTMENT',
      client: params.client,
      lines: [
        {
          account: '1020',
          side: 'DEBIT',
          amount,
          merchantId,
          riderId,
          narration: `Reversal of failed payout funds back to bank operating account (Ref: ${params.reference})`,
        },
        {
          account: targetAccount,
          side: 'CREDIT',
          amount,
          merchantId,
          riderId,
          narration: `Restoration of payable balance due to failed transfer (Ref: ${params.reference})`,
        },
      ],
    });
  }

  /**
   * Batch S: Post-Clawback Future Earnings Offset
   * Settles open Merchant Receivable (1040) against newly earned Merchant Payable (2020)
   * Dr 2020 Merchant Accounts Payable, Cr 1040 Merchant Receivables / Clawbacks
   */
  public async recordClawbackOffset(params: {
    merchantId: string;
    amount: number;
    orderId?: string;
    reference: string;
    client?: pg.PoolClient;
  }): Promise<string> {
    const txRef = `TX_CLAWBACK_OFFSET_${params.reference}`;
    const amount = assertPositiveMoney(params.amount, 'clawbackOffsetAmount');

    return this.postJournalBatch({
      txRef,
      transactionType: 'ADJUSTMENT',
      client: params.client,
      lines: [
        {
          account: '2020',
          side: 'DEBIT',
          amount,
          orderId: params.orderId || null,
          merchantId: params.merchantId,
          narration: `Apply seller earnings payable against outstanding clawback receivable (Ref: ${params.reference})`,
        },
        {
          account: '1040',
          side: 'CREDIT',
          amount,
          orderId: params.orderId || null,
          merchantId: params.merchantId,
          narration: `Clearance of merchant clawback receivable 1040 via earnings offset (Ref: ${params.reference})`,
        },
      ],
    });
  }

  /**
   * Batch Q: Pre-Fulfillment Cancellation Escrow Release
   * Dr 2010 Customer Funds Held in Escrow, Cr 1010 Cash at Gateway / Escrow
   */
  public async recordPreFulfillmentCancellationRefund(params: {
    orderId: string;
    refundId?: string;
    refundNumber?: string;
    amount: number;
    client?: pg.PoolClient;
  }): Promise<string> {
    const refundKey = params.refundNumber || params.refundId || 'FULL';
    const txRef = `TX_CANCEL_REFUND_${params.orderId}_${refundKey}`;
    const amount = assertPositiveMoney(params.amount, 'refundAmount');

    return this.postJournalBatch({
      txRef,
      transactionType: 'REFUND',
      client: params.client,
      lines: [
        {
          account: '2010',
          side: 'DEBIT',
          amount,
          orderId: params.orderId,
          narration: `Cancellation refund: release customer escrow liability for order ${params.orderId} (Ref: ${refundKey})`,
        },
        {
          account: '1010',
          side: 'CREDIT',
          amount,
          orderId: params.orderId,
          narration: `Cancellation refund: gateway escrow cash returned for order ${params.orderId} (Ref: ${refundKey})`,
        },
      ],
    });
  }

  /**
   * Batch R: Post-Fulfillment Return & Refund General Ledger Entry
   * Pre-Payout: Dr 2020 Merchant Payable (+ fees), Cr 1010 Cash at Gateway
   * Partially Settled: Dr 2020 Merchant Payable (unsettled portion) + Dr 1040 Merchant Receivable (settled portion) (+ fees), Cr 1010 Cash at Gateway
   * Post-Payout: Dr 1040 Merchant Receivable (+ fees), Cr 1010 Cash at Gateway
   * Guarantees sum(Debits) == sum(Credits) == refundAmount
   */
  public async recordReturnRefund(params: {
    orderId: string;
    merchantId: string;
    refundAmount: number;
    isPostPayout?: boolean;
    netGoodsAmount?: number;
    payableReductionAmount?: number;
    clawbackReceivableAmount?: number;
    commissionAmount?: number;
    commissionGst?: number;
    gstTcsAmount?: number;
    sellerTdsAmount?: number;
    storeDelayPenalty?: number;
    platformSubsidyReversal?: number;
    returnId?: string;
    refundId?: string;
    refundNumber?: string;
    creditAccountCode?: '1010' | '1020';
    client?: pg.PoolClient;
  }): Promise<string> {
    const key = params.returnId || params.refundId || params.refundNumber || params.orderId;
    const txRef = `TX_RETURN_REFUND_${key}`;
    const refundOutAccount = params.creditAccountCode || '1010';

    const refundTotal = assertPositiveMoney(params.refundAmount, 'refundAmount');
    const platformSubsidyReversal = assertNonNegativeMoney(params.platformSubsidyReversal || 0, 'platformSubsidyReversal');
    const targetAccount = params.isPostPayout ? '1040' : '2020';

    const comm = assertNonNegativeMoney(params.commissionAmount || 0, 'commissionAmount');
    const commGst = assertNonNegativeMoney(params.commissionGst || 0, 'commissionGst');
    const tcs = assertNonNegativeMoney(params.gstTcsAmount || 0, 'gstTcsAmount');
    const tds = assertNonNegativeMoney(params.sellerTdsAmount || 0, 'sellerTdsAmount');
    const delayPen = assertNonNegativeMoney(params.storeDelayPenalty || 0, 'storeDelayPenalty');
    const feeTotalBn = add(comm, commGst, tcs, tds, delayPen);

    const hasSplit = params.payableReductionAmount !== undefined || params.clawbackReceivableAmount !== undefined;
    let payableReduction = hasSplit
      ? assertNonNegativeMoney(params.payableReductionAmount || 0, 'payableReductionAmount')
      : 0;
    let clawbackReceivable = hasSplit
      ? assertNonNegativeMoney(params.clawbackReceivableAmount || 0, 'clawbackReceivableAmount')
      : 0;

    if (!hasSplit) {
      const netGoods =
        params.netGoodsAmount !== undefined
          ? assertNonNegativeMoney(params.netGoodsAmount, 'netGoodsAmount')
          : Number(roundCurrency(BigNumber.max(0, subtract(refundTotal, feeTotalBn))));
      if (params.isPostPayout) {
        clawbackReceivable = netGoods;
      } else {
        payableReduction = netGoods;
      }
    }

    const entries: {
      account: string;
      side: 'DEBIT' | 'CREDIT';
      amount: number;
      narration: string;
      orderId?: string;
      merchantId?: string;
    }[] = [];

    // 1. Debit Merchant Payable (2020) and/or Merchant Receivable / Clawback (1040)
    if (payableReduction > 0) {
      entries.push({
        account: '2020',
        side: 'DEBIT',
        amount: payableReduction,
        narration: `Pre-payout return debit reducing merchant payable for order ${params.orderId}`,
        orderId: params.orderId,
        merchantId: params.merchantId,
      });
    }
    if (clawbackReceivable > 0) {
      entries.push({
        account: '1040',
        side: 'DEBIT',
        amount: clawbackReceivable,
        narration: `Post-payout return clawback debit against merchant ${params.merchantId} for order ${params.orderId}`,
        orderId: params.orderId,
        merchantId: params.merchantId,
      });
    }

    // 2. Proportional Fee Reversals if applicable
    if (comm > 0) {
      entries.push({
        account: '4010',
        side: 'DEBIT',
        amount: comm,
        narration: `Reversal of commission on returned goods for order ${params.orderId}`,
        orderId: params.orderId,
        merchantId: params.merchantId,
      });
    }
    if (commGst > 0) {
      entries.push({
        account: '2070',
        side: 'DEBIT',
        amount: commGst,
        narration: `Reversal of output GST on platform commission for order ${params.orderId}`,
        orderId: params.orderId,
      });
    }
    if (tcs > 0) {
      entries.push({
        account: '2040',
        side: 'DEBIT',
        amount: tcs,
        narration: `Adjustment of Section 52 GST-TCS on return for order ${params.orderId}`,
        orderId: params.orderId,
      });
    }
    if (tds > 0) {
      entries.push({
        account: '2050',
        side: 'DEBIT',
        amount: tds,
        narration: `Adjustment of Section 393/194-O TDS on return for order ${params.orderId}`,
        orderId: params.orderId,
      });
    }
    if (delayPen > 0) {
      entries.push({
        account: '4030',
        side: 'DEBIT',
        amount: delayPen,
        narration: `Proportional reversal of store delay penalty on returned order ${params.orderId}`,
        orderId: params.orderId,
        merchantId: params.merchantId,
      });
    }

    // 3. Credit Cash at Gateway (1010) for prepaid orders or Bank Operating Account (1020) for COD return refunds
    entries.push({
      account: refundOutAccount,
      side: 'CREDIT',
      amount: refundTotal,
      narration:
        refundOutAccount === '1020'
          ? `COD bank transfer refund disbursed to customer for order ${params.orderId}`
          : `Gateway refund disbursed to customer for order ${params.orderId}`,
      orderId: params.orderId,
    });

    // 4. Credit COA 5040 (Promotional Subsidy Expense Reversal) when platform-funded discount is clawed back on return
    if (platformSubsidyReversal > 0) {
      entries.push({
        account: '5040',
        side: 'CREDIT',
        amount: platformSubsidyReversal,
        narration: `Reversal of platform-funded promotional subsidy upon return for order ${params.orderId}`,
        orderId: params.orderId,
        merchantId: params.merchantId,
      });
    }

    let totalDebitsBn = entries
      .filter((e) => e.side === 'DEBIT')
      .reduce((s, e) => s.plus(toDecimal(e.amount)), new BigNumber(0));
    const totalCreditsBn = entries
      .filter((e) => e.side === 'CREDIT')
      .reduce((s, e) => s.plus(toDecimal(e.amount)), new BigNumber(0));
    const diffBn = totalCreditsBn.minus(totalDebitsBn);

    if (diffBn.abs().gt(0.05)) {
      throw new Error(
        `LEDGER_UNBALANCED: Return refund batch unbalanced (Debits: ${roundCurrency(totalDebitsBn)}, Credits: ${roundCurrency(totalCreditsBn)}, Diff: ${roundCurrency(diffBn)}).`
      );
    } else if (!diffBn.isZero()) {
      const adjTarget =
        entries.find((e) => e.account === targetAccount && toDecimal(e.amount).plus(diffBn).gt(0)) ||
        entries.find((e) => e.side === 'DEBIT' && toDecimal(e.amount).plus(diffBn).gt(0));
      if (adjTarget) {
        adjTarget.amount = Number(roundCurrency(toDecimal(adjTarget.amount).plus(diffBn)));
        totalDebitsBn = entries
          .filter((e) => e.side === 'DEBIT')
          .reduce((s, e) => s.plus(toDecimal(e.amount)), new BigNumber(0));
      }
      if (!totalCreditsBn.eq(totalDebitsBn)) {
        throw new Error(
          `LEDGER_UNBALANCED: Return refund rounding adjustment failed (${roundCurrency(totalDebitsBn)} != ${roundCurrency(totalCreditsBn)}).`
        );
      }
    }

    return this.postJournalBatch({
      txRef,
      transactionType: 'REFUND',
      lines: entries,
      client: params.client,
    });
  }

  /**
   * Reconciles trial balance across all Chart of Accounts entries
   * Validates sum(Debits) == sum(Credits)
   */
  public async getTrialBalance(client?: pg.PoolClient): Promise<{
    totalDebits: number;
    totalCredits: number;
    isBalanced: boolean;
    difference: number;
    accounts: {
      accountCode: string;
      accountName: string;
      category: string;
      normalBalance: string;
      debitTotal: number;
      creditTotal: number;
      netBalance: number;
    }[];
  }> {
    const runner = client || getPool();

    const res = await runner.query(`
      SELECT 
        a.account_code,
        a.account_name,
        a.category,
        a.normal_balance,
        COALESCE(SUM(CASE WHEN e.entry_side = 'DEBIT' THEN e.amount ELSE 0 END), 0) AS debit_total,
        COALESCE(SUM(CASE WHEN e.entry_side = 'CREDIT' THEN e.amount ELSE 0 END), 0) AS credit_total
      FROM general_ledger_accounts a
      LEFT JOIN general_ledger_entries e ON a.account_code = e.account_code
      GROUP BY a.account_code, a.account_name, a.category, a.normal_balance
      ORDER BY a.account_code ASC
    `);

    let totalDebitsBn = new BigNumber(0);
    let totalCreditsBn = new BigNumber(0);

    const accounts = res.rows.map((r) => {
      const dBn = toDecimal(roundCurrency(r.debit_total));
      const cBn = toDecimal(roundCurrency(r.credit_total));
      totalDebitsBn = totalDebitsBn.plus(dBn);
      totalCreditsBn = totalCreditsBn.plus(cBn);
      const netBn = r.normal_balance === 'DEBIT' ? dBn.minus(cBn) : cBn.minus(dBn);

      return {
        accountCode: r.account_code,
        accountName: r.account_name,
        category: r.category,
        normalBalance: r.normal_balance,
        debitTotal: Number(roundCurrency(dBn)),
        creditTotal: Number(roundCurrency(cBn)),
        netBalance: Number(roundCurrency(netBn)),
      };
    });

    const totalDebits = Number(roundCurrency(totalDebitsBn));
    const totalCredits = Number(roundCurrency(totalCreditsBn));
    const difference = Number(roundCurrency(totalDebitsBn.minus(totalCreditsBn)));
    const isBalanced = totalDebitsBn.eq(totalCreditsBn);

    return {
      totalDebits,
      totalCredits,
      isBalanced,
      difference,
      accounts,
    };
  }
}

export const ledgerService = new LedgerService();

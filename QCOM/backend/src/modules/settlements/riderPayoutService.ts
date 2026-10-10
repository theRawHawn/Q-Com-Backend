import crypto from 'crypto';
import pg from 'pg';
import { getPool, transaction } from '../../database/connection.js';
import { ledgerService } from '../ledger/ledgerService.js';
import { getPayoutProvider, PayoutProvider } from './payoutProvider.js';
import { RiderEarningsStatement, PayoutResult } from './settlementTypes.js';
import { settlementEventPublisher, SettlementDomainEvent } from './settlementEvents.js';

export class RiderPayoutService {
  private payoutProvider: PayoutProvider;

  constructor() {
    this.payoutProvider = getPayoutProvider();
  }

  /**
   * Generates comprehensive earnings and floating cash statement for a delivery partner
   */
  public async getRiderEarningsStatement(riderId: string): Promise<RiderEarningsStatement> {
    const pool = getPool();

    const riderRes = await pool.query(`
      SELECT id, name, phone, pan_number, pan_status, kyc_status,
             wallet_balance, floating_cash_balance, floating_cash_limit,
             status, is_payout_held, payout_hold_reason,
             upi_vpa, bank_account_number, bank_ifsc
      FROM riders
      WHERE id = $1
      LIMIT 1
    `, [riderId]);

    if (riderRes.rows.length === 0) {
      throw new Error(`RIDER_NOT_FOUND: Rider '${riderId}' does not exist.`);
    }

    const r = riderRes.rows[0];

    const tripsRes = await pool.query(`
      SELECT t.*, o.order_number
      FROM delivery_trips t
      JOIN orders o ON t.order_id = o.id
      WHERE t.rider_id = $1 AND t.status = 'DELIVERED'
      ORDER BY t.delivered_at DESC
    `, [riderId]);

    let totalGrossEarnings = 0;
    let totalTips = 0;
    let totalTdsWithheld = 0;
    let totalNetEarnings = 0;

    const trips = tripsRes.rows.map((t) => {
      const base = parseFloat(t.base_fare || '35.00');
      const dist = parseFloat(t.distance_fare || '0.00');
      const surge = parseFloat(t.surge_fare || '0.00');
      const wait = parseFloat(t.wait_time_compensation || '0.00');
      const tip = parseFloat(t.tip_amount || '0.00');
      const tds = parseFloat(t.rider_withholding_amount || '0.00');
      const net = +(base + dist + surge + wait + tip - tds).toFixed(2);

      totalGrossEarnings += +(base + dist + surge + wait).toFixed(2);
      totalTips += tip;
      totalTdsWithheld += tds;
      totalNetEarnings += net;

      return {
        tripId: t.id,
        orderId: t.order_id,
        deliveredAt: t.delivered_at ? t.delivered_at.toISOString() : new Date().toISOString(),
        baseFare: base,
        distanceFare: dist,
        surgeFare: surge,
        waitCompensation: wait,
        customerTip: tip,
        tdsWithheld: tds,
        netPayout: net,
      };
    });

    const payoutRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_paid_out
      FROM rider_payouts
      WHERE rider_id = $1 AND status = 'PAID'
    `, [riderId]);

    const totalPaidOut = parseFloat(payoutRes.rows[0].total_paid_out);
    const floatingCash = parseFloat(r.floating_cash_balance || '0.00');
    const floatingLimit = parseFloat(r.floating_cash_limit || '2500.00');
    const isDispatchBlocked = floatingCash >= floatingLimit || r.status === 'SUSPENDED';

    return {
      riderId: r.id,
      riderName: r.name,
      panNumber: r.pan_number || undefined,
      panStatus: r.pan_status || undefined,
      kycStatus: r.kyc_status,
      walletBalance: parseFloat(r.wallet_balance || '0.00'),
      floatingCashBalance: floatingCash,
      floatingCashLimit: floatingLimit,
      isDispatchBlocked,
      upiVpa: r.upi_vpa || undefined,
      bankDetails: {
        accountNumber: r.bank_account_number || undefined,
        ifsc: r.bank_ifsc || undefined,
      },
      totalGrossEarnings: +totalGrossEarnings.toFixed(2),
      totalTips: +totalTips.toFixed(2),
      totalTdsWithheld: +totalTdsWithheld.toFixed(2),
      totalNetEarnings: +totalNetEarnings.toFixed(2),
      totalPaidOut: +totalPaidOut.toFixed(2),
      trips,
    };
  }

  /**
   * Executes instant or scheduled rider wallet payout
   */
  public async executeRiderPayout(params: {
    riderId: string;
    amount?: number;
    method?: 'UPI' | 'BANK';
    idempotencyKey?: string;
  }): Promise<PayoutResult> {
    const { riderId, amount, method = 'UPI', idempotencyKey } = params;
    const stagedEvents: SettlementDomainEvent[] = [];

    const result = await transaction(async (client) => {
      // 1. Idempotency Check
      if (idempotencyKey) {
        const existingPayoutRes = await client.query(`
          SELECT * FROM rider_payouts
          WHERE idempotency_key = $1
          LIMIT 1
          FOR UPDATE
        `, [idempotencyKey]);

        if (existingPayoutRes.rows.length > 0) {
          const row = existingPayoutRes.rows[0];
          return {
            payoutId: row.id,
            payoutReference: row.payout_reference,
            actorId: row.rider_id,
            amount: parseFloat(row.amount),
            status: row.status,
            utrNumber: row.utr_number || undefined,
            journalBatchId: row.journal_batch_id || undefined,
            isDuplicate: true,
          };
        }
      }

      // 2. Row-level lock on rider
      const riderRes = await client.query(`
        SELECT * FROM riders
        WHERE id = $1
        FOR UPDATE
      `, [riderId]);

      if (riderRes.rows.length === 0) {
        throw new Error(`RIDER_NOT_FOUND: Rider '${riderId}' does not exist.`);
      }

      const rider = riderRes.rows[0];

      if (rider.is_payout_held) {
        throw new Error(`PAYOUT_HELD: Payouts for rider '${riderId}' are held: ${rider.payout_hold_reason || 'Compliance review'}`);
      }

      const currentWallet = parseFloat(rider.wallet_balance || '0.00');
      if (currentWallet <= 0) {
        throw new Error('ZERO_WALLET_BALANCE: Rider wallet balance is zero.');
      }

      const payoutAmount = amount ? Math.min(amount, currentWallet) : currentWallet;
      if (payoutAmount <= 0) {
        throw new Error('INVALID_PAYOUT_AMOUNT: Payout amount must be greater than zero.');
      }

      // Destination validation
      if (method === 'UPI' && !rider.upi_vpa) {
        throw new Error('MISSING_DESTINATION: Rider has no UPI VPA configured.');
      }
      if (method === 'BANK' && (!rider.bank_account_number || !rider.bank_ifsc)) {
        throw new Error('MISSING_DESTINATION: Rider has no bank account configured.');
      }

      const payoutReference = `PAYOUT_RIDER_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

      // 3. Call external Payout Provider
      const providerRes = await this.payoutProvider.disburseRiderPayout({
        riderId,
        amount: payoutAmount,
        method,
        vpa: rider.upi_vpa,
        accountNumber: rider.bank_account_number,
        ifsc: rider.bank_ifsc,
        reference: payoutReference,
      });

      if (!providerRes.success) {
        throw new Error(`PAYOUT_PROVIDER_REJECTED: ${providerRes.failureReason || 'Disbursement rejected by banking rail.'}`);
      }

      // 4. Post double-entry general ledger batch (Dr 2030 Rider Wallet, Cr 1020 Bank Account)
      const journalBatchId = await ledgerService.recordRiderPayout({
        riderId,
        amount: payoutAmount,
        payoutReference,
        utrNumber: providerRes.utrNumber,
        client,
      });

      // 5. Post subledger entry in rider_ledgers
      const updatedWallet = +(currentWallet - payoutAmount).toFixed(2);
      await client.query(`
        INSERT INTO rider_ledgers (
          rider_id, entry_type, category, amount, running_balance, utr_number, description
        )
        VALUES ($1, 'INSTANT_PAYOUT_DEBIT', 'DEBIT', $2, $3, $4, $5)
      `, [
        riderId,
        payoutAmount,
        updatedWallet,
        providerRes.utrNumber,
        `Disbursement to ${method === 'UPI' ? rider.upi_vpa : rider.bank_account_number} (Ref: ${payoutReference}, UTR: ${providerRes.utrNumber})`,
      ]);

      // 6. Deduct from rider's wallet balance
      await client.query(`
        UPDATE riders
        SET wallet_balance = wallet_balance - $2,
            updated_at = NOW()
        WHERE id = $1
      `, [riderId, payoutAmount]);

      // 7. Record in rider_payouts table
      const insRes = await client.query(`
        INSERT INTO rider_payouts (
          payout_reference, rider_id, amount, currency, payout_method,
          destination_vpa, destination_account, destination_ifsc,
          status, utr_number, provider_payout_id, journal_batch_id, idempotency_key, processed_at
        )
        VALUES ($1, $2, $3, 'INR', $4, $5, $6, $7, 'PAID', $8, $9, $10, $11, NOW())
        RETURNING *
      `, [
        payoutReference,
        riderId,
        payoutAmount,
        method,
        rider.upi_vpa || null,
        rider.bank_account_number || null,
        rider.bank_ifsc || null,
        providerRes.utrNumber,
        providerRes.providerPayoutId,
        journalBatchId,
        idempotencyKey || null,
      ]);

      const payoutRow = insRes.rows[0];

      // 8. Stage Post-Commit Domain Event
      stagedEvents.push(
        settlementEventPublisher.createEvent('RiderPayoutCompleted', {
          payoutId: payoutRow.id,
          payoutReference,
          riderId,
          amount: payoutAmount,
          method,
          utrNumber: providerRes.utrNumber,
          journalBatchId,
        })
      );

      return {
        payoutId: payoutRow.id,
        payoutReference,
        actorId: riderId,
        amount: payoutAmount,
        status: 'PAID',
        utrNumber: providerRes.utrNumber,
        journalBatchId,
        isDuplicate: false,
      };
    });

    if (stagedEvents.length > 0) {
      settlementEventPublisher.publishAll(stagedEvents);
    }

    return result;
  }

  /**
   * Authoritative Floating Cash (COD) Remittance
   * Deducts floating cash liability, records general ledger transfer, and unblocks suspended rider
   */
  public async remitCodCash(params: {
    riderId: string;
    amount: number;
    method?: 'UPI' | 'HUB';
    reference?: string;
  }): Promise<{ success: boolean; remittedAmount: number; remainingCash: number; unblocked: boolean }> {
    const { riderId, amount, method = 'UPI', reference } = params;
    const stagedEvents: SettlementDomainEvent[] = [];

    const result = await transaction(async (client) => {
      // 1. Lock rider
      const riderRes = await client.query(`
        SELECT * FROM riders
        WHERE id = $1
        FOR UPDATE
      `, [riderId]);

      if (riderRes.rows.length === 0) {
        throw new Error(`RIDER_NOT_FOUND: Rider '${riderId}' does not exist.`);
      }

      const rider = riderRes.rows[0];
      const floatingCash = parseFloat(rider.floating_cash_balance || '0.00');

      if (amount <= 0 || amount > floatingCash) {
        throw new Error(`INVALID_REMITTANCE_AMOUNT: Remittance amount ₹${amount} exceeds current floating cash ₹${floatingCash}.`);
      }

      const remittedAmount = +amount.toFixed(2);
      const remainingCash = +(floatingCash - remittedAmount).toFixed(2);
      const remitRef = reference || `REMIT_COD_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

      // 2. Post double-entry general ledger batch (Dr 1020 Bank Account, Cr 1030 Floating Cash)
      await ledgerService.recordRiderCodRemittance({
        riderId,
        amount: remittedAmount,
        reference: remitRef,
        client,
      });

      // 3. Post Subledger entry in rider_ledgers
      const currentWallet = parseFloat(rider.wallet_balance || '0.00');
      await client.query(`
        INSERT INTO rider_ledgers (
          rider_id, entry_type, category, amount, running_balance, description
        )
        VALUES ($1, 'COD_DEDUCTION', 'DEBIT', $2, $3, $4)
      `, [
        riderId,
        remittedAmount,
        currentWallet,
        `Remittance of physical COD cash via ${method} (Ref: ${remitRef})`,
      ]);

      // 4. Update rider floating cash and unblock if below ceiling
      const floatingLimit = parseFloat(rider.floating_cash_limit || '2500.00');
      const unblocked = remainingCash < floatingLimit && rider.status === 'SUSPENDED';

      await client.query(`
        UPDATE riders
        SET floating_cash_balance = $2,
            status = CASE WHEN $3 = TRUE THEN 'IDLE_AT_HUB' ELSE status END,
            updated_at = NOW()
        WHERE id = $1
      `, [riderId, remainingCash, unblocked]);

      // 5. Stage Post-Commit Event
      stagedEvents.push(
        settlementEventPublisher.createEvent('RiderCodRemitted', {
          riderId,
          remittedAmount,
          remainingCash,
          unblocked,
          method,
          reference: remitRef,
        })
      );

      return {
        success: true,
        remittedAmount,
        remainingCash,
        unblocked,
      };
    });

    if (stagedEvents.length > 0) {
      settlementEventPublisher.publishAll(stagedEvents);
    }

    return result;
  }
}

export const riderPayoutService = new RiderPayoutService();

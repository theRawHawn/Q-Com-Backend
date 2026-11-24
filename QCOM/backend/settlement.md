# QCOM Financial Settlement & Payout Engine Specification

**Document Version:** 3.0.0 (Phase 0.5 Final Correction Pass — September 2026)  
**Accounting Standard:** Double-Entry General Ledger (Chart of Accounts)  
**Statutory Frameworks:**
- Section 52 of CGST Act, 2017 (GST-TCS on E-Commerce Supplies)
- **Income-tax Act, 2025 (Section 393)** for transactions on/after 1 April 2026
- **Income-tax Act, 1961 (Sections 194-O, 194-C)** for transactions prior to 1 April 2026

---

## 1. Merchant / Seller Settlement Engine

### 1.1 Dynamic Statutory Settlement Formula
All deductions are resolved dynamically from versioned rules in `statutory_withholding_rules` based on transaction date and payee tax attributes:

$$\begin{aligned}
\text{Gross GMV} &= \sum (\text{Line Item Price} \times \text{Quantity}) \\
\text{Platform Commission} &= \text{Taxable Item Total} \times \text{Merchant Commission Rate (e.g. 15\%)} \\
\text{GST on Commission} &= \text{Platform Commission} \times 18\% \quad (\text{SAC 9983}) \\
\text{GST-TCS (Sec 52)} &= \text{Net Taxable Supplies} \times \text{Active Versioned TCS Rate} \\
\text{Income-Tax Withholding} &= \text{Gross GMV} \times \text{Active Rule Rate} \\
&\quad (\text{Income-tax Act 2025, Sec 393(1), Table 8(v) for 2026+}) \\
\text{Store Delay Penalties} &= \text{Packing delay minutes past 5 min} \times ₹1.20 \quad (\text{Debited from Merchant}) \\
\text{Net Merchant Payable} &= \text{Gross GMV} - \text{Platform Commission} - \text{GST on Commission} \\
&\quad - \text{GST-TCS} - \text{Income-Tax Withholding} - \text{Store Delay Penalties}
\end{aligned}$$

### 1.2 Dual-Regime Withholding Resolution
| Transaction Date | Governing Statute | Provision Reference | Base Rate (Valid PAN) | Higher Rate (Non-PAN) | Exemption Threshold |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Prior to 01-Apr-2026** | Income-tax Act, 1961 | Section 194-O | 0.1% | Resolved via rule | Individual/HUF $\le ₹5,00,000$ |
| **On/After 01-Apr-2026** | Income-tax Act, 2025 | Section 393, Table 8(v) | 0.1% | Resolved via rule | Resolved per new Act provisions |

---

## 2. Delivery Partner Payout Engine & Customer Tip Treatment

### 2.1 Separation of Tip Business Rules from Tax Conclusions
1. **QCOM Business Policy**:
   - Platform Commission on Tip = **₹0.00**
   - Rider Tip Payable = **100% of customer tip** (zero platform haircut)
2. **Tax Engine Determination**:
   - The tax engine independently inspects the characterization of delivery earnings and tips according to the governing withholding rules active on the transaction date:
     - `tip_amount`: Recorded as customer tip contribution
     - `platform_tip_commission`: ₹0.00
     - `rider_tip_payable`: Equal to `tip_amount`
     - Statutory withholding applied according to active Section 393 (or legacy 194-C) rule conditions.

### 2.2 Payout Formula
$$\begin{aligned}
\text{Gross Rider Logistics Fare} &= \text{Base Fare (₹35)} + \text{Distance Pay (₹8/km > 2km)} \\
&\quad + \text{Transit Time Pay (₹0.50/min)} + \text{Surge Multiplier Bonus} \\
&\quad + \text{Wait Time Compensation (₹1.20/min past 5m)} \\
\text{Customer Tips} &= \text{Rider Tip Payable (100\% pass-through per business rule)} \\
\text{Statutory Withholding} &= \text{Gross Fare} \times \text{Active Logistics Withholding Rule Rate} \\
\text{Net Cash Settled} &= (\text{Gross Rider Fare} + \text{Customer Tips} - \text{Statutory Withholding}) \\
&\quad - \text{Floating Cash (COD) Collected}
\end{aligned}$$

### 2.3 Floating Cash (COD) Liability & ₹2,500 Hard Ceiling
- **Liability Mechanics**: Cash on Delivery collected by a delivery partner is platform money held in trust.
- **Ceiling Rules**:
  - `floating_cash_balance >= ₹2,000.00`: Persistent amber alert displayed in Rider App with nearest hub navigation.
  - `floating_cash_balance >= ₹2,500.00`: Immediate automatic suspension of dispatch task broadcasts.
- **Remittance**:
  - **Dynamic UPI QR Code**: Rider scans QR generated via `/api/qrider/cod/qr-code` to remit collected funds via instant UPI/IMPS.
  - **Hub Deposit**: Physical remittance at merchant hub with manager acknowledgement in Admin Portal.
  - Once remitted, `floating_cash_balance` is debited, and task dispatch unblocks instantly.

---

## 3. Double-Entry General Ledger Architecture

### 3.1 Fundamental Accounting Invariant
> **CORE INVARIANT:**  
> Within every journal transaction and batch, the sum of all Debits MUST equal the sum of all Credits:
> $$\sum \text{Debits} \equiv \sum \text{Credits}$$
> **IMMUTABILITY RULE:**  
> Application services and Super Admin API users are not permitted to update or delete historical ledger records (`LEDGER_IMMUTABLE` triggers plus `REVOKE UPDATE, DELETE, TRUNCATE ... FROM PUBLIC`). Any correction or adjustment MUST occur through a new, auditable reversal or adjustment journal entry. Production database connections should run under a non-owner `NOSUPERUSER` role because PostgreSQL superusers/table owners can bypass or disable triggers via DDL.

### 3.2 Standard Chart of Accounts (COA)
| Account Code | Account Name | Category | Normal Balance |
| :--- | :--- | :--- | :--- |
| `1010` | Cash at Payment Gateway / Escrow | Current Asset | Debit |
| `1020` | Bank Operating Account | Current Asset | Debit |
| `1030` | Floating Cash in Hands of Riders (COD) | Current Asset | Debit |
| `1040` | Seller Clawback Receivable | Current Asset | Debit |
| `1050` | Rider Cash Shortage Receivable | Current Asset | Debit |
| `2010` | Customer Funds Held in Escrow | Current Liability | Credit |
| `2020` | Merchant Accounts Payable (Seller Ledger) | Current Liability | Credit |
| `2030` | Delivery Partner Wallet Payable (Rider Ledger) | Current Liability | Credit |
| `2040` | GST-TCS Section 52 Payable to Government | Current Liability | Credit |
| `2050` | Income-Tax Withholding Payable (Sec 393 / 194-O)| Current Liability | Credit |
| `2060` | Logistics Withholding Payable (Sec 393 / 194-C) | Current Liability | Credit |
| `2070` | Output GST Liability on Commission/Fees | Current Liability | Credit |
| `2080` | Unidentified / Excess COD Cash Suspense | Current Liability | Credit |
| `4010` | Marketplace Commission Revenue (SAC 9983) | Platform Revenue | Credit |
| `4020` | Customer Delivery Fee Revenue (SAC 9968) | Platform Revenue | Credit |
| `4030` | Convenience & Handling Fee Revenue (SAC 9985) | Platform Revenue | Credit |
| `5010` | Delivery Rider Logistics Expense | Operating Expense | Debit |
| `5020` | Payment Gateway Interchange Fees | Operating Expense | Debit |
| `5030` | COD Cash Variance & Authorized Write-Off Expense | Operating Expense | Debit |

### 3.3 Reversal & Adjustment Accounting Pattern
When an order refund or return is approved post-settlement:
```
-- NEVER execute: UPDATE general_ledger_entries SET amount = 0 WHERE ...
-- INSTEAD, execute an atomic Reversal Journal Batch:
Journal Batch: JRN-REV-9901
Debit:  2020 Merchant Accounts Payable          ₹817.76
Debit:  4010 Marketplace Commission Revenue     ₹127.12
Debit:  2070 Output GST Liability on Fee         ₹22.88
Debit:  2040 GST-TCS Payable Reversal             ₹4.24
Debit:  2050 Income-Tax Withholding Reversal      ₹0.82
Credit: 1010 Cash at Gateway / Escrow                      ₹972.82
(Reversal Batch Balance: Debits ₹972.82 == Credits ₹972.82)
```

### 3.4 Sprint 15.5 Lifecycle, Allocation & Append-Only Guarantees
- **Append-Only Subledgers, Batches & General Ledger:** `ledger_journal_batches`, `general_ledger_entries`, `seller_ledgers`, and `rider_ledgers` forbid `UPDATE`, `DELETE`, and `TRUNCATE` via PostgreSQL triggers (`LEDGER_IMMUTABLE`) paired with `REVOKE UPDATE, DELETE, TRUNCATE ... FROM PUBLIC` (enforced for all non-superuser/non-owner roles; triggers do not substitute for restricting superuser/owner credentials). `ledger_journal_batches` enforces atomic `transaction_reference` claiming with canonical `payload_hash` verification, and monotonic `seq_no` triggers guarantee deterministic running balances.
- **FIFO Partial Allocation Settlement & Reversal:** `order_settlement_allocations` retains `status = 'ALLOCATED'` while tracking cumulative `settled_amount` and `refunded_amount`, transitioning to `'SETTLED'` when `settled_amount + refunded_amount >= net_seller_payable - 0.01`, or `'REVERSED'` only upon full reversal.
- **Partial & Post-Payout Clawback Offset (`2020` / `1040 -> 2020`):** Return clawbacks debit `2020` (`RETURN_DEBIT`) up to the remaining unsettled portion of an allocation and debit `1040` (`Seller Clawback Receivable`, `CLAWBACK_DEBIT`) for the settled portion alongside proportional fee/delay-penalty reversals (`4010`, `2070`, `2040`, `2050`, `4030`), automatically offsetting subsequent eligible seller allocations (`Dr 2020 / Cr 1040`).
- **Post-`PAID` Bank Reversal & Replay Guard:** Webhook failure/reversal transitions `PAID -> REVERSED` (terminal), restores seller/rider balances via compensating ledger credits and FIFO allocation reversion, and ignores duplicate or out-of-order webhooks against terminal payouts.
- **Idempotent COD Remittance:** `remitCodCash` delegates into `codCashAccountabilityService.submitRemittance`, enforcing server-derived collection custody, two-person receipt & verification workflows, and balanced GL postings.

### 3.5 Sprint 15.9 COD Cash Accountability, Multi-Stage Remittance & Separation of Duties
- **Authoritative Collection Custody (`cod_collections`):** `completeDeliveryWithOtp` rejects `allowPartial: true` (`400 PARTIAL_COD_NOT_SUPPORTED`), ignores client-supplied cash amounts, derives the authoritative `orders.total_amount` under row locks (`orders -> delivery_trips -> riders`), creates a 1:1 `cod_collections` record, posts balanced `COD_COLLECTION` (`Dr 1030 / Cr 2010`), increments `riders.floating_cash_balance`, and keeps `delivery_trips.cod_reconciled = FALSE` until verification clears the underlying order collection.
- **COD Refunds Without Gateway Abuse:** `refundService.createRefund` rejects uncollected COD orders (`ORDER_NOT_REFUNDABLE` / `COD_REFUND_NO_COLLECTION`). Completed COD return refunds settle without invoking an external payment gateway, recording `provider_id = 'COD_BANK_TRANSFER'` and crediting `1020` (Bank Operating Account) rather than `1010` (Gateway Escrow).
- **Three-Stage Remittance Lifecycle & Separation of Duties:**
  1. **Submit (`DRAFT -> SUBMITTED`):** Rider or authorized admin submits a remittance (`POST /api/v1/settlements/cod/remittances` or `/cod/remit`), reserving open `cod_collections` via explicit `orderIds`/`collectionIds` or deterministic FIFO (`cod_remittance_allocations`). Liability is **not** reduced at submission. Protected by `codRemittanceRateLimiter` (15 req/min fail-closed) and PostgreSQL idempotency (`uq_cod_remittances_idempotency`).
  2. **Physical Receipt (`SUBMITTED -> RECEIVED | VERIFICATION_PENDING`):** Hub/Operations/Finance staff (`POST /cod/remittances/:id/receive`) acknowledges physical handover; blocked if caller matches `submitted_by` or rider user (`403 SELF_RECEIPT_FORBIDDEN`).
  3. **Independent Finance Verification (`RECEIVED -> LIABILITY_CLEARED | SHORTAGE | EXCESS`):** Finance Admin/Super Admin (`POST /cod/remittances/:id/verify`) must be distinct from both submitter (`403 SELF_VERIFICATION_FORBIDDEN`) and receiver (`403 RECEIVER_VERIFICATION_CONFLICT`), also enforced by DB `CHECK` constraints. Exact verification posts `COD_REMITTANCE` (`Dr 1020 / Cr 1030`), clears allocations, marks fully cleared trips `cod_reconciled = TRUE`, and clears `cod_restricted` when under ceiling with zero active disputes.
- **Shortage, Excess, Dispute Resolution & Reversal:**
  - Shortages (`verifiedAmount < submittedAmount`) clear only the verified amount, keep the residual unpaid balance on rider liability, and open a `SHORTAGE` row in `cod_cash_disputes` (restricting COD dispatch via `active_cod_dispute_count`). Resolutions include `RECOVERED_CASH` (`Dr 1020 / Cr 1030`), `RECOVERED_FROM_WALLET` (withholding-safe deduction via `rider_ledgers`), `ESCALATED_TO_RECEIVABLE` (`Dr 1050 / Cr 1030`), and finance-only `WRITTEN_OFF` (`Dr 5030 / Cr 1030` or `Cr 1050`).
  - Excesses (`verifiedAmount > submittedAmount`) credit suspense `2080` (`Dr 1020 / Cr 1030 + Cr 2080`) and open an `EXCESS` dispute (`EXCESS_RETURNED` or `EXCESS_ALLOCATED_TO_COLLECTION`).
  - Verified remittances can be reversed (`POST /cod/remittances/:id/reverse`) by posting an offsetting `COD_REVERSAL` journal batch, restoring `1030` liability and reopening `cod_collections` and `delivery_trips.cod_reconciled`.
- **Dispatch Blocking, Ceiling Overrides & Reconciliation Checks (13–13F):** `cod_restricted` and expired overrides block COD dispatch cleanly (`409 RIDER_COD_RESTRICTED` on manual admin COD assignment and exclusion in `candidateGenerator`). `paymentReconciliationService` (Checks `13–13F`) detects delivered COD orders lacking collections, GL drift vs materialized `floating_cash_balance`, overdue unverified remittances, and safely auto-repairs only missing `delivery_trips.cod_reconciled` flags once collections are fully cleared; `financialRecoveryWorker.monitorCodRemittancesAndOverrides()` escalates stale unverified remittances and enforces expired overrides.


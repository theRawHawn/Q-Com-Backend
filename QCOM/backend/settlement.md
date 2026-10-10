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
> No user, including Super Admin, is permitted to update or delete historical ledger records. Any correction or adjustment MUST occur through a new, auditable reversal or adjustment journal entry.

### 3.2 Standard Chart of Accounts (COA)
| Account Code | Account Name | Category | Normal Balance |
| :--- | :--- | :--- | :--- |
| `1010` | Cash at Payment Gateway / Escrow | Current Asset | Debit |
| `1020` | Bank Operating Account | Current Asset | Debit |
| `1030` | Floating Cash in Hands of Riders (COD) | Current Asset | Debit |
| `2010` | Customer Funds Held in Escrow | Current Liability | Credit |
| `2020` | Merchant Accounts Payable (Seller Ledger) | Current Liability | Credit |
| `2030` | Delivery Partner Wallet Payable (Rider Ledger) | Current Liability | Credit |
| `2040` | GST-TCS Section 52 Payable to Government | Current Liability | Credit |
| `2050` | Income-Tax Withholding Payable (Sec 393 / 194-O)| Current Liability | Credit |
| `2060` | Logistics Withholding Payable (Sec 393 / 194-C) | Current Liability | Credit |
| `2070` | Output GST Liability on Commission/Fees | Current Liability | Credit |
| `4010` | Marketplace Commission Revenue (SAC 9983) | Platform Revenue | Credit |
| `4020` | Customer Delivery Fee Revenue (SAC 9968) | Platform Revenue | Credit |
| `4030` | Convenience & Handling Fee Revenue (SAC 9985) | Platform Revenue | Credit |
| `5010` | Delivery Rider Logistics Expense | Operating Expense | Debit |
| `5020` | Payment Gateway Interchange Fees | Operating Expense | Debit |

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

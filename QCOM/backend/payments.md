# QCOM Payment & Refund Architecture Specification

**Payment Gateway Integration:** Razorpay Payment Suite (UPI, NetBanking, Cards) & Cash-on-Delivery (COD)  
**Security Standard:** HMAC-SHA256 Cryptographic Verification & Server-Side Due Settlement  

---

## 1. Supported Payment Rails

1. **Instant UPI (Intent & Dynamic QR)**: Zero-friction mobile payment for tradespeople and contractors.
2. **Corporate & Credit/Debit Cards**: Supported via 3D Secure / Razorpay Checkout.
3. **Cash-on-Delivery (Pay on Delivery / Pay on Jobsite)**: Subject to ₹2,500 maximum order cap and rider floating cash ceiling.
4. **Trade Credit (Net 30)**: Pre-approved B2B credit lines for verified contractors with high credit ratings.

---

## 2. Server-Authoritative Payment Flow

```
   Customer App                      QCOM Backend                      Razorpay Gateway
        │                                 │                                   │
        │ 1. Request Order Intent         │                                   │
        ├────────────────────────────────>│                                   │
        │                                 │ 2. Create Gateway Order           │
        │                                 ├──────────────────────────────────>│
        │                                 │<──────────────────────────────────┤
        │                                 │ 3. Sign Order with HMAC-SHA256    │
        │ 4. Return Order ID & Signature  │                                   │
        │<────────────────────────────────┤                                   │
        │                                                                     │
        │ 5. Execute Payment in App (UPI / Card)                              │
        ├────────────────────────────────────────────────────────────────────>│
        │<────────────────────────────────────────────────────────────────────┤
        │ 6. Submit Payment Proof (paymentId, signature)                      │
        ├────────────────────────────────>│                                   │
        │                                 │ 7. Cryptographic Verification     │
        │                                 │    (recalculates HMAC signature)  │
        │                                 │ 8. Mark Order Status: PAID        │
        │ 9. Order Confirmed              │                                   │
        │<────────────────────────────────┤                                   │
```

### 2.1 Cryptographic Payment Signature Generation
```typescript
export function generatePaymentSignature(orderId: string, amount: number, timestamp: number): string {
  const payload = `${orderId}|${amount.toFixed(2)}|${timestamp}`;
  return crypto.createHmac('sha256', process.env.PAYMENT_SECRET!).update(payload).digest('hex');
}
```

---

## 3. Webhook Handling & Idempotency

- Endpoint: `POST /api/webhooks/razorpay`
- **Validation**: Verifies `x-razorpay-signature` header using `crypto.createHmac('sha256', webhookSecret)`.
- **Supported Events**:
  - `payment.captured`: Sets order `payment_status = 'PAID'`. Emits `PaymentConfirmed` event.
  - `payment.failed`: Sets order `payment_status = 'FAILED'`. Alerts customer to retry.
  - `refund.processed`: Marks refund record as `SETTLED`. Updates customer ledger.
- **Idempotency Guarantee**: Every webhook payload event ID is logged in the `webhook_events` table within a serializable database transaction. Duplicate events are silently acknowledged with HTTP 200.

---

## 4. Refund Architecture & Dispute Resolution

### 4.1 Refund Types & Triggers
1. **Automated Order Cancellation**: Order cancelled before packing starts -> 100% automated refund to original payment source.
2. **Item Stockout / Substitution Shortage**: Item unavailable at merchant -> Partial refund for missing line items + proportional GST.
3. **Damaged / Defective Part**: Handled via Seller/Admin dispute panel -> Refund processed after photo inspection approval.

### 4.2 Gateway Refund Execution Flow
```typescript
async function processGatewayRefund(paymentId: string, refundAmount: number, reason: string) {
  // Authoritative call to Razorpay API
  const response = await razorpayClient.payments.refund(paymentId, {
    amount: Math.round(refundAmount * 100), // in paise
    notes: { reason },
    receipt: `ref_${Date.now()}`
  });
  return response;
}
```

### 4.3 Cash-on-Delivery (COD) Reconciliation Security (CWE-602 Remediation)
- When a rider collects cash at the jobsite, the rider client CANNOT dictate the reconciled cash amount.
- The backend reconciles strictly against the database-authoritative order invoice due (`orders.total_amount`).
- Any attempt to submit `cashCollected = 0` or tampered values is rejected with HTTP 400 (`Financial Integrity Violation`).

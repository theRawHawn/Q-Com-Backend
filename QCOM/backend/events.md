# QCOM Event-Driven Architecture, Messaging & Background Jobs

**Messaging Engine:** Redis Streams / Kafka Event Bus & BullMQ Task Queues  
**Event Pattern:** Event Sourcing & Publish-Subscribe for Real-Time Cross-App Sync  

---

## 1. Standard Domain Event Envelope

All asynchronous domain events adhere to an immutable JSON envelope:

```json
{
  "eventId": "evt_01HZX829A4K8M9Q1Z",
  "eventType": "order.packed",
  "version": "1.0.0",
  "timestamp": "2026-09-24T12:45:00.120Z",
  "actorId": "staff_blr_04",
  "actorType": "STORE_STAFF",
  "correlationId": "ord_9901",
  "payload": {
    "orderId": "ord_9901",
    "merchantId": "merch_koramangala_01",
    "handoverToken": "PK-8819",
    "sealedBagCount": 2,
    "totalWeightKg": 3.8
  }
}
```

---

## 2. Canonical Domain Event Catalog

| Event Name | Producer | Consumers | Actions Triggered |
| :--- | :--- | :--- | :--- |
| `order.created` | Customer App | Inventory, Store Queue | Stocks reserved; Seller app triggers loud chime and starts 8-min prep SLA timer. |
| `payment.confirmed`| Payment Gateway | Orders, Finance | Order state flipped to `placed`; Tax invoice generated; WhatsApp receipt dispatched. |
| `order.accepted` | Seller App | Customer App, Admin | Customer notified: *"Store is preparing your order"*; picking checklist displayed to staff. |
| `order.packed` | Seller App | Dispatch Engine | Handover token `PK-XXXX` generated; algorithmic broadcast initiates to nearby riders. |
| `task.broadcasted` | Dispatch Engine| Delivery App | Targeted rider's device sounds 85dB broadcast audio with 30s countdown modal. |
| `task.claimed` | Delivery App | Seller, Admin, Dispatch | Broadcast stops; Rider assigned; Seller sees rider name, vehicle, and 5-min arrival ETA. |
| `rider.at_pickup` | Delivery App | Seller App | Seller notified: *"Rider has arrived at entrance for Handover PK-XXXX"*. |
| `order.handover` | Seller / Rider | Customer, Dispatch | Status changes to `out_for_delivery`; live tracking map activates in Customer App. |
| `rider.at_dropoff`| Delivery App | Customer App | Fused GPS triggers geofence alert: *"Rider is outside your jobsite/doorstep"*. |
| `order.delivered` | Delivery App | Finance, Inventory | Customer OTP verified; Delivery marked complete; Merchant & Rider ledgers credited. |
| `order.cancelled` | Admin / Customer| Store, Fleet, Finance | Locks released; stock re-credited; full refund queued if paid online. |

---

## 3. Background Queues & Scheduled Workers (BullMQ)

```
+-----------------------------------------------------------------------------------+
|                            BACKGROUND TASK QUEUES                                 |
+-----------------------------------------------------------------------------------+
| 1. Dispatch Escalation Queue    | 2. Shift & Attendance Worker                    |
| - 30s broadcast timeout cascade | - Revokes shift slot if rider >1km away at 15m  |
| - Re-assigns to next best rider | - Issues strike penalty for unexcused no-shows  |
+---------------------------------+-------------------------------------------------+
| 3. Unreachable Countdown Queue  | 4. Financial Settlement Cron                    |
| - 5-min timer for missing user  | - Tuesday 02:00 AM weekly merchant payout batch |
| - Initiates 2 automated IVR calls- Generates bank-format NEFT/IMPS NACH files    |
+---------------------------------+-------------------------------------------------+
```

### 3.1 Unreachable Protocol Worker Pattern
```typescript
dispatchQueue.process('customer-unreachable-timer', async (job) => {
  const { orderId, tripId } = job.data;
  const trip = await getTrip(tripId);
  
  if (trip.status !== 'ARRIVED_AT_DROP' || trip.otpVerified) {
    return; // Customer was found or order already verified
  }
  
  // Trigger automated telephony call via masked IVR bridge
  await triggerAutomatedIvrCall(orderId);
  
  // If final countdown expired without customer contact:
  await authorizeReturnToMerchantStore(tripId, {
    reason: 'CUSTOMER_UNREACHABLE_TIMEOUT',
    riderBonus: 25.00
  });
});
```

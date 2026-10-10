# QCOM Order Lifecycle & State Machine Specification

**Document Version:** 3.0.0 (Phase 0.5 Final Correction Pass — September 2026)  
**Lifecycle Model:** Deterministic Finite State Automaton (FSA)  
**SLA Target:** 15 to 30 Minutes End-to-End Delivery  

---

## 1. Canonical State Transition Diagram

```
       [Customer Checkouts]
                │
                ▼
           ┌──────────┐   (Seller Rejects / Timeout / User Cancel)
           │  placed  ├─────────────────────────────────────────────┐
           └────┬─────┘                                             │
                │ (Seller Accepts Order)                            │
                ▼                                                   │
           ┌──────────┐                                             │
           │ picking  │                                             │
           └────┬─────┘                                             │
                │ (Staff Packs & Seals Bag -> PK-XXXX Generated)    │
                ▼                                                   │
           ┌──────────┐                                             │
           │  packed  │                                             │
           └────┬─────┘                                             │
                │ (Rider Scans Handover Token PK-XXXX & Departs)    ▼
                ▼                                            ┌───────────┐
      ┌──────────────────┐                                   │ cancelled │
      │ out_for_delivery │                                   └───────────┘
      └─────────┬────────┘                                          ▲
                │ (Rider within 500m Geofence)                      │
                ▼                                                   │
           ┌──────────┐                                             │
           │ arriving │                                             │
           └────┬─────┘                                             │
                │ (Customer 4-Digit OTP Verified / Contactless Proof)│
                ▼                                                   │
          ┌───────────┐                                             │
          │ delivered │                                             │
          └───────────┘                                             │
                ▲                                                   │
                │ (Customer Unreachable: Return to Hub Protocol)    │
                └───────────────────────────────────────────────────┘
```

---

## 2. Order Creation & Authoritative Concurrency Invariants

1. **Direct PostgreSQL Inventory Decrement (CAS)**:
   - Order creation executes inside a serializable PostgreSQL transaction:
     ```sql
     UPDATE store_inventory
     SET stock_count = stock_count - $qty,
         reserved_count = reserved_count + $qty,
         version = version + 1
     WHERE product_id = $productId AND merchant_id = $merchantId AND stock_count >= $qty;
     ```
   - If any line item returns 0 updated rows, the transaction immediately rolls back and returns `409 Conflict: OUT_OF_STOCK`.
2. **Database Failure Handling (Zero Uncommitted Orders in Redis)**:
   - If PostgreSQL connection fails, the order is **NEVER queued into Redis/BullMQ**.
   - The API immediately responds with `503 Service Unavailable` with `Retry-After: 3`. The client retries using its client-generated `Idempotency-Key`.
3. **Tip Separation**:
   - Order stores:
     - `tip_amount`: Full amount tipped by customer
     - `platform_tip_commission`: ₹0.00
     - `rider_tip_payable`: Equal to `tip_amount`
     - Tax engine dynamically determines withholding per governing rules.
4. **Dynamic Withholding Snapshot**:
   - Order record stores:
     - `withholding_amount`: Computed tax deduction
     - `withholding_rule_id`: Foreign key to `statutory_withholding_rules`
     - `withholding_law`: `INCOME_TAX_ACT_2025` (or `1961` for pre-April 2026)
     - `withholding_provision`: `SECTION_393`
     - `withholding_table_item`: `TABLE_8_V`
     - `tax_year`: `2026-27`
     - `gst_tcs_amount` & `gst_tcs_rule_id`

---

## 3. Operational Protocols & Exception Handling

### 3.1 Store Packing Delay & Rider Wait-Time Compensation
- Prep SLA: **8 minutes**.
- If store preparation exceeds 5 minutes from order acceptance:
  - Seller App triggers high-frequency audio alerts.
  - Live wait-time meter starts compensating the arriving rider at **₹1.20 per minute**.
  - Delay pay is debited from merchant ledger and credited to rider wallet.

### 3.2 Customer Unreachable Protocol
1. Rider arrives at jobsite and initiates "Customer Unreachable" flow.
2. Mandatory **5-minute countdown** starts; 2 automated masked IVR calls are triggered.
3. If customer does not respond before timer expires:
   - Dispatch routes rider back to the merchant store to return sealed parcel.
   - Rider receives **100% trip fare + ₹25.00 return trip compensation**.
   - Merchant staff inspects tamper-evident seal and restocks items via `/api/seller/returns/:id/restock`.

### 3.3 Delivery Verification
- **Standard**: Customer enters 4-digit PIN OTP on rider's device.
- **Contactless**: High-resolution photo uploaded with EXIF timestamp and GPS watermark, verified within 50m of destination.

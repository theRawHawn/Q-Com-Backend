# SPRINT 6 — PAYMENT STATE MACHINE SPECIFICATION

**Target Domain:** `QCOM/backend` Payment Core & Webhook Engine  
**Author:** Backend Architecture Lead  
**Status:** **ACTIVE & ENFORCED**

---

## 1. PAYMENT STATES

| State | Category | Description |
| :--- | :--- | :--- |
| **`CREATED`** | Initial | Payment intent record created in PostgreSQL; signature generated; awaiting provider/client initiation. |
| **`PENDING`** | Processing | Payment challenge presented to customer or awaiting asynchronous payment confirmation. |
| **`AUTHORIZED`** | Pre-Capture | Payment authorized by issuer; funds held on customer account prior to capture. |
| **`CAPTURED`** | Successful Terminal | Funds captured into payment gateway escrow asset account (1010); stock committed; receipt created. |
| **`FAILED`** | Terminal | Payment declined, expired, or failed provider authentication. |
| **`CANCELLED`** | Terminal | Payment intent voided due to user cancellation or order timeout. |
| **`PARTIALLY_REFUNDED`** | Post-Capture | A portion of captured funds returned to customer (foundation for Sprint 9 returns). |
| **`REFUNDED`** | Terminal | Total captured amount refunded to customer. |

---

## 2. STATE TRANSITION MATRIX

| From State | Allowed Target States | Idempotent Repeat | Forbidden Target States |
| :--- | :--- | :--- | :--- |
| **`CREATED`** | `PENDING`, `AUTHORIZED`, `CAPTURED`, `FAILED`, `CANCELLED` | `CREATED` | `REFUNDED`, `PARTIALLY_REFUNDED` |
| **`PENDING`** | `AUTHORIZED`, `CAPTURED`, `FAILED`, `CANCELLED` | `PENDING` | `CREATED`, `REFUNDED`, `PARTIALLY_REFUNDED` |
| **`AUTHORIZED`** | `CAPTURED`, `FAILED`, `CANCELLED` | `AUTHORIZED` | `CREATED`, `PENDING`, `REFUNDED`, `PARTIALLY_REFUNDED` |
| **`CAPTURED`** | `PARTIALLY_REFUNDED`, `REFUNDED` | `CAPTURED` | `CREATED`, `PENDING`, `AUTHORIZED`, `FAILED`, `CANCELLED` |
| **`FAILED`** | None | `FAILED` | All other states |
| **`CANCELLED`** | None | `CANCELLED` | All other states |
| **`PARTIALLY_REFUNDED`**| `PARTIALLY_REFUNDED`, `REFUNDED` | `PARTIALLY_REFUNDED` | `CREATED`, `PENDING`, `AUTHORIZED`, `CAPTURED`, `FAILED`, `CANCELLED` |
| **`REFUNDED`** | None | `REFUNDED` | All other states |

---

## 3. ORDER RECONCILIATION COUPLING

| Payment State | `orders.payment_status` | Inventory Effect | Double-Entry Ledger Effect |
| :--- | :--- | :--- | :--- |
| `CREATED` | `PENDING` | Stock Remains Reserved | None |
| `PENDING` | `PENDING` | Stock Remains Reserved | None |
| `AUTHORIZED` | `PENDING` | Stock Remains Reserved | None |
| `CAPTURED` | `PAID` | Stock Committed (`RESERVED` $\rightarrow$ `COMMITTED`) | DEBIT 1010, CREDIT 2010 |
| `FAILED` | `FAILED` (if order abandoned) | None (stock released if order cancelled) | None |
| `CANCELLED` | `FAILED` / `PENDING` | Stock Released (`RESERVED` $\rightarrow$ `RELEASED`) | None |
| `REFUNDED` | `REFUNDED` | Determined by Returns Engine (Sprint 9) | DEBIT 2010, CREDIT 1010 |

---

## 4. INVARIANT ENFORCEMENT RULES

1. **Row-Level Lock Invariant:** All payment transitions on `orders` and `payment_intents` must be wrapped in `SELECT ... FOR UPDATE` inside a PostgreSQL transaction.
2. **Terminal Invariant:** Once in `FAILED`, `CANCELLED`, or `REFUNDED`, no state change is permitted.
3. **Capture Irreversibility:** Once `CAPTURED`, a payment can never transition back to `PENDING` or `FAILED`.
4. **Exactly-Once Side Effects:** Only the first successful transition into `CAPTURED` triggers inventory commit and ledger posting. All duplicate attempts must return the existing receipt.

# Instructions for AI Coding Agents & Engineers (AGENTS)

**Target Codebase:** QCOM Multi-Tenant Quick Commerce Marketplace  
**Authoritative Backend:** `QCOM/backend`  
**Frontend Roots (Protected):** `QCOM/customer-app`, `QCOM/seller-app`, `QCOM/delivery-app`, `QCOM/admin-portal`  

---

## 1. Prime Directives & Invariants

1. **Do Not Modify Protected Frontend Source Files:**  
   Frontend directories (`QCOM/customer-app/src/**`, `QCOM/seller-app/src/**`, `QCOM/delivery-app/**`, `QCOM/admin-portal/src/**`) are protected. Do not alter frontend components or clients unless explicitly authorized in the prompt.
2. **PostgreSQL 16 is Authoritative:**  
   Never store primary business state, payment balances, or inventory counts exclusively in Redis or process memory. PostgreSQL 16 is the single source of truth.
3. **Double-Entry Bookkeeping:**  
   Any modification affecting money (orders, payments, refunds, settlements, payouts) must balance to zero (Total Debits == Total Credits) in `journal_entries`.
4. **Idempotency is Non-Negotiable:**  
   All state-changing endpoints and webhook handlers must guard against duplicate submissions via database constraints (`UNIQUE`) and atomic status transitions.
5. **No External Payment Gateway Calls:**  
   Do not connect to external third-party payment gateways or invent live API keys. Testing must use provider abstractions and sandboxes.

---

## 2. Developer Workflow & Verification

1. **Running Tests:**  
   Execute backend test battery using:
   ```bash
   npm run test:backend
   ```
   All test suites (37+ suites) must pass with a 100% success rate.
2. **Database Migrations:**  
   Always write sequential migration files in `QCOM/backend/migrations/` using advisory locking. Never mutate historical migration files (001-023) directly.
3. **Compiling the Applet:**  
   Verify root compilation using `compile_applet` before completing turns.
4. **Documentation Sync:**  
   When modifying APIs, tables, or security behavior, update the respective canonical documentation (`DATABASE.md`, `API.md`, `AUTH.md`).

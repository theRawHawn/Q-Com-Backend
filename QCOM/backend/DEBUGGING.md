# QCOM Platform — Troubleshooting & Operational Debugging Guide (DEBUGGING)

---

## 1. Health & Readiness Diagnostics

| Endpoint | Expected Status | Troubleshooting Action on Failure |
| :--- | :--- | :--- |
| `GET /health/live` | `200 OK` | Process is unresponsive or Node.js event loop blocked. Check heap dumps or process restart logs. |
| `GET /health/ready` | `200 OK` | PostgreSQL database connection or Redis cluster failed. Check `DATABASE_URL` connectivity and pool saturation. |

---

## 2. Common Operational Issues & Remediation

### 2.1 Database Advisory Lock Deadlock
- **Symptom:** Migration script hangs on startup waiting for `pg_advisory_lock(42424242)`.
- **Cause:** Previous deployment worker crashed or timed out mid-migration.
- **Resolution:**
  ```sql
  SELECT pg_advisory_unlock(42424242);
  ```

### 2.2 Payment State Machine Re-query
- **Symptom:** Payment intent stuck in `PROCESSING` state.
- **Diagnostics:** Check `payment_intent_recovery_leases` table to verify whether a recovery worker holds an active lease:
  ```sql
  SELECT * FROM payment_intent_recovery_leases WHERE status = 'ACTIVE';
  ```
- **Resolution:** `financialRecoveryWorker` will automatically claim expired leases and re-query provider status.

### 2.3 Webhook Deduplication & Signature Errors
- **Symptom:** Webhook returns `400 Bad Request: INVALID_WEBHOOK_SIGNATURE`.
- **Diagnostics:** Verify that the incoming `X-Razorpay-Signature` matches the computed HMAC-SHA256 signature using `RAZORPAY_WEBHOOK_SECRET`.
- **Symptom:** Webhook returns `{ success: true, duplicate: true }`.
- **Diagnostics:** Normal behavior. An event with the same `event_id` was already processed, and duplicate side-effects were prevented.

### 2.4 WebSocket Handshake Failure
- **Symptom:** Client connection to `/ws/v1` receives `401 Unauthorized`.
- **Resolution:** Ensure client includes `?token=<valid_jwt>` in query parameters or passes `Authorization: Bearer <jwt>`. Expired or revoked sessions will be rejected.

---

## 3. Security Warning

**Never log raw passwords, OTP codes, bearer tokens, session keys, or payment gateway secrets.**  
All system logs must sanitize authorization headers and sensitive payload fields before writing to output streams.

# QCOM Security, Threat Model & Vulnerability Remediations

**Security Baseline:** OWASP API Security Top 10 & CWE Hardened Backend Matrix  
**Architecture:** Zero-Trust Authoritative Server Architecture  

---

## 1. Vulnerability Remediation Matrix (Strix Red-Team Audit)

The codebase incorporates proactive remediations for critical vulnerabilities identified across the ecosystem:

| Vulnerability / CWE | Description | Attack Vector | Authoritative Remediation in QCOM Backend |
| :--- | :--- | :--- | :--- |
| **CWE-362: Concurrency Race Condition** | Simultaneous stock purchase or delivery batch claim | Two riders claim same high-payout batch; or two customers buy last stock unit | Atomic Compare-and-Swap (CAS) database queries (`WHERE rider_id IS NULL`) and ordered distributed mutex locks. |
| **CWE-602: Client-Side Security Enforcement** | Client tampered pricing or COD cash values | Attacker submits `totalAmount: 1` or rider submits `cashCollected: 0` | Server ignores client values; recalculates authoritative prices and enforces database invoice due amounts. |
| **CWE-639: Broken Object-Level Auth (BOLA/IDOR)** | Customer A accesses Customer B's order details | Changing `/orders/:id` parameter to read other contractor's invoices | Strict ownership validation (`order.userId === req.user.id || order.jobSite.phone === req.user.phone`). |
| **CWE-862: Missing Authorization** | Rider updates telemetry without valid session | Unauthenticated caller spoofs rider GPS coordinates | `verifyRiderToken` middleware enforcing bearer JWT validation on all telemetry routes. |
| **CWE-20: Input Validation & GPS Spoofing** | Impossible velocity teleportation | Mock location app jumps coordinates across city in 1 second | Velocity plausibility filter calculating physical speed; rejects pings $> 120\text{ km/h}$ with HTTP 422. |
| **CWE-287: Improper WebSocket Auth** | PII eavesdropping on dispatch socket channels | Malicious actor connects to WebSocket and listens to customer addresses | Socket handshake JWT authentication and room-level RBAC (`join_fleet_channel` requires verified `dispatcher` role). |
| **CWE-565: Reliance on Client-Controlled State** | Client sets KYC status to `APPROVED` | Manipulating local state or request payload to bypass KYC | Backend queries authoritative Postgres `riders.kyc_status` table; never trusts client claims. |
| **CWE-840: Business Logic Flaws & Double-Payout** | Rapid-click double withdrawal | Double-tapping instant payout button drains wallet twice | Mandatory `Idempotency-Key` header with 24-hour cache deduplication. |
| **CWE-841: Workflow State Bypass** | Jumping from `placed` straight to `delivered` | Directly calling `/advance-stage` to mark order delivered without pickup | Deterministic state machine enforcing sequential transitions and requiring 4-digit OTP. |

---

## 2. Infrastructure & Ingress Hardening

### 2.1 Prototype Pollution Defense
To neutralize prototype pollution attacks targeting V8 object prototypes:
```typescript
try {
  Object.freeze(Object.prototype);
} catch (e) {
  // Graceful fallback in environments with strict descriptors
}

export function sanitizeObject<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObject) as unknown as T;
  
  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue; // Strip pollution vectors
    }
    clean[key] = typeof value === 'object' ? sanitizeObject(value) : value;
  }
  return clean as T;
}
```

### 2.2 Server-Side Request Forgery (SSRF) Defense
Outbound HTTP requests (webhooks, geocoding, telephony proxies) pass through an IP filter blocking private, loopback, and cloud metadata ranges:
```typescript
export function isPrivateOrReservedIp(ip: string): boolean {
  // Blocks 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.169.254 (AWS/GCP metadata)
  return /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|169\.254\.)/.test(ip);
}
```

### 2.3 Multi-Tier Sliding Window Rate Limiting
| Tier | Key Prefix | Window | Limit | Target Endpoints |
| :--- | :--- | :--- | :--- | :--- |
| **General** | `rl:gen` | 60s | 300 | Browsing catalog, reading profile, app navigation |
| **Quote & Calc** | `rl:quote` | 60s | 60 | `/api/checkout/quote`, `/api/routing/calculate` |
| **Sensitive Ops**| `rl:sens` | 60s | 40 | Payout releases, refunds, KYC approval, RBAC changes |
| **Order Placement**| `rl:ord` | 60s | 10 | `/api/orders/create` |
| **Authentication**| `rl:otp` | 600s | 3 | `/api/auth/request-otp` |

# QCOM Authentication & Authorization (RBAC) Specification

**Security Model:** Defense-in-Depth Multi-Tenant Access Control  
**Token Standard:** Cryptographic HMAC-SHA256 Signed Bearer Tokens & High-Entropy Session Strings  

---

## 1. Authentication Mechanisms by Actor

```
+-----------------------------------------------------------------------------------+
|                        ACTOR AUTHENTICATION TOPOLOGY                              |
+-----------------------------------------------------------------------------------+
| 1. Customer         2. Delivery Partner    3. Seller Merchant   4. Admin Portal   |
| - Mobile Phone      - Phone + DL / KYC     - Staff Phone + PIN  - Employee Code   |
| - 6-Digit SMS OTP   - Helmet Selfie Check  - Store ID Scoping   - High-Entropy Hex|
| - 30-Day JWT        - 12-Hour Session      - Role (Owner/Staff) - 24-Hour Session |
+-----------------------------------------------------------------------------------+
```

### 1.1 Customer Authentication
- **Flow**: Phone number submission -> 6-digit numeric OTP generated and sent via SMS gateway -> OTP verification -> JWT issuance.
- **Security Defenses**:
  - Max 3 OTP requests per phone number within a 10-minute sliding window.
  - Max 5 failed OTP verification attempts triggers an automatic 15-minute phone lockout.
  - OTP tokens are single-use; replay attempts immediately fail.
  - Dev/Test OTP bypasses are strictly disabled in production environments (`NODE_ENV === 'production'`).

### 1.2 Delivery Partner Authentication & Interlocks
- **Flow**: Phone + OTP verification bound to validated Rider ID and vehicle plate.
- **Safety Interlocks**:
  - Duty toggle to `ONLINE` requires:
    1. Phone battery level ≥ 15% (or connected to charger).
    2. High-accuracy GPS enabled with background permission granted.
    3. KYC Status in `GREEN` state (Aadhaar, DL, PAN verified).
    4. Floating cash balance < ₹2,500.00 ceiling.

### 1.3 Seller Merchant & Store Staff Authentication
- **Multi-Role Scoping**: Every staff member belongs to a specific `merchant_id`.
- **Roles**:
  1. `STORE_OWNER`: Full financial visibility, bank details modification, instant payout requests.
  2. `STORE_MANAGER`: Order acceptance, stock adjustments, store pause/online toggle.
  3. `STAFF_PACKER`: Restricted strictly to order picking, packing, and physical rider handover.

### 1.4 Admin & Operations Authentication
- **Session Tokens**: High-entropy strings (`qcom_adm_<64_hex_chars>`).
- **Validation**:
  - Tokens are validated against the authoritative employee database on EVERY request.
  - Headers accepted: `Authorization: Bearer <token>` or `x-admin-session-token`.
  - Roles supplied in request headers (`x-admin-role`) are NEVER blindly trusted for authorization; permissions are resolved server-side.

---

## 2. Dynamic RBAC Permission Matrix

Admin capabilities are governed by 12 granular module permission groups:

```typescript
export type AdminPermission =
  // Command Center & Operations
  | 'dashboard.view'
  // Orders
  | 'orders.view' | 'orders.create' | 'orders.edit' | 'orders.update_status'
  | 'orders.assign_rider' | 'orders.cancel' | 'orders.refund' | 'orders.export'
  // Customers
  | 'customers.view' | 'customers.edit' | 'customers.suspend' | 'customers.reactivate' | 'customers.export'
  // Merchants / Sellers
  | 'sellers.view' | 'sellers.create' | 'sellers.edit' | 'sellers.approve'
  | 'sellers.suspend' | 'sellers.commission' | 'sellers.export'
  // Delivery Fleet
  | 'riders.view' | 'riders.onboard' | 'riders.edit' | 'riders.approve_kyc'
  | 'riders.suspend' | 'riders.broadcast' | 'riders.payout' | 'riders.export'
  // Inventory
  | 'inventory.view' | 'inventory.edit_stock' | 'inventory.price_override' | 'inventory.export'
  // Financial Settlements
  | 'settlements.view' | 'settlements.process' | 'settlements.export'
  // Refunds & Disputes
  | 'refunds.view' | 'refunds.create' | 'refunds.approve' | 'refunds.dispute_resolve'
  // Service Areas
  | 'service_areas.view' | 'service_areas.manage'
  // Pricing Rules
  | 'pricing.view' | 'pricing.manage'
  // Security & Audit
  | 'audit.view' | 'audit.export'
  // Employee Governance
  | 'employees.view' | 'employees.create' | 'employees.edit' | 'employees.delete' | 'employees.roles_manage';
```

---

## 3. Middleware Enforcement Implementation

```typescript
// Role/Permission Guard Middleware Pattern
export function requirePermission(permission: AdminPermission) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.employee) {
      return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Admin authentication required.' });
    }
    const hasPermission = req.effectivePermissions?.includes(permission) || req.employee.role === 'SUPER_ADMIN';
    if (!hasPermission) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        requiredPermission: permission,
        message: `Insufficient privileges: requires '${permission}' permission.`
      });
    }
    next();
  };
}
```

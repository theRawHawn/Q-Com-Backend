# QCOM Testing Strategy & Verification Suites

**Coverage Target:** 100% Critical Financial & Security Paths | Zero Untested Race Conditions  
**Test Frameworks:** Node.js Native Test Runner / Vitest & Supertest  

---

## 1. Test Suite Matrix

```
+-----------------------------------------------------------------------------------+
|                            QCOM AUTOMATED TEST SUITES                             |
+-----------------------------------------------------------------------------------+
| 1. Pricing & Tax Engine Suite        | 2. Security & Red-Team Pentest Suite       |
| - 100m distance rounding formula     | - OTP brute force & replay lockout tests   |
| - Slabs (5%, 12%, 18%, 28%)          | - Price tampering & negative quantities    |
| - CGST/SGST/IGST intra/inter split   | - BOLA / IDOR cross-customer access tests  |
| - Section 194-O / 194-C deductions   | - Prototype pollution payload rejection    |
+--------------------------------------+--------------------------------------------+
| 3. Concurrency & Race Condition Suite| 4. Geospatial & Routing Telematics Suite   |
| - Simultaneous stock buy (atomic CAS)| - Dual entrance accessible pins snapping   |
| - Simultaneous delivery batch claim  | - Impossible velocity (>120 km/h) filter   |
| - Instant payout double-click retry  | - Real-time rerouting on stray departure   |
+--------------------------------------+--------------------------------------------+
```

---

## 2. Core Execution Commands

```bash
# 1. Run Authoritative Delivery Pricing Suite
npx tsx QCOM/customer-app/test-pricing-suite.ts

# 2. Run Delivery Economics & Dynamic Pricing Suite
npx tsx QCOM/customer-app/test_part2_delivery_economics.ts

# 3. Run Routing & Accessible Pins Suite
npx tsx QCOM/customer-app/test-routing-suite.ts

# 4. Run Comprehensive Red-Team Security & Pentest Suite
npx tsx QCOM/customer-app/test-security.ts
```

---

## 3. High-Priority Concurrency Test Scenario (CWE-362)

```typescript
// Test Specification: Deterministic Race Condition Prevention
async function testStockRaceCondition() {
  const productId = 'plumb-brass-valve-01';
  // Set stock to exactly 10 units
  await setStock(productId, 10);

  // Dispatch two concurrent checkout requests of 10 units each
  const [orderA, orderB] = await Promise.allSettled([
    placeOrder({ customerId: 'cust-1', items: [{ productId, quantity: 10 }] }),
    placeOrder({ customerId: 'cust-2', items: [{ productId, quantity: 10 }] })
  ]);

  // Assert: Exactly ONE order succeeded (200 OK) and ONE failed with 409 Conflict
  const successCount = [orderA, orderB].filter(r => r.status === 'fulfilled').length;
  const failureCount = [orderA, orderB].filter(r => r.status === 'rejected' && r.reason?.status === 409).length;

  assert(successCount === 1, 'Exactly one order must succeed');
  assert(failureCount === 1, 'Competing order must fail with 409 Out of Stock');
  assert((await getStock(productId)) === 0, 'Final remaining stock must be 0, never negative');
}
```

---

## 4. Telemetry Anti-Spoofing Test Scenario (CWE-20)

```typescript
// Test Specification: Reject Teleportation & Impossible Velocity
async function testGpsSanityCheck() {
  const riderId = 'rider-test-01';
  
  // First ping at Koramangala
  await sendTelemetry(riderId, { lat: 12.9352, lng: 77.6245, clientTime: Date.now() });

  // Second ping 2 seconds later at Whitefield (15 km away -> speed ~27,000 km/h)
  const res = await sendTelemetry(riderId, { 
    lat: 12.9698, 
    lng: 77.7500, 
    clientTime: Date.now() + 2000 
  });

  assert(res.status === 422, 'Must reject impossible GPS velocity');
  assert(res.body.cwe === 'CWE-20', 'Must flag CWE-20 input validation failure');
}
```

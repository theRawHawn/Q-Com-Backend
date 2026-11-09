# QCOM Delivery Dispatch, Fleet & Geospatial Architecture

**Routing Standard:** Zero-API-Key OpenStreetMap & OSRM Engine with Dual Accessible Pins  
**Dispatch Latency Target:** Sub-15s Algorithmic Broadcast to Delivery Partners  

---

## 1. Vehicle Constraint & Payload Matrix

Hardware and automotive parts range from micro-fasteners to 100kg submersible pumps. Dispatch matching enforces hard vehicle physical constraints:

| Vehicle Class | Operating Radius | Payload Limit | Archetypal Cargo Types |
| :--- | :--- | :--- | :--- |
| **Bicycle** | $\le 2.5\text{ km}$ | $\le 5\text{ kg}$ | Screws, fasteners, modular switches, Teflon tape, wire nuts |
| **EV Scooter (Light)** | $\le 6.0\text{ km}$ | $\le 15\text{ kg}$ | Power drills, angle grinders, cable coils (90m), faucet mixers |
| **Motorcycle / ICE** | $\le 10.0\text{ km}$ | $\le 25\text{ kg}$ | Brake discs, 5L motor oil drums, pipe fittings, heavy tool sets |
| **Cargo 3-Wheeler (EV)**| Full Zone | $\le 120\text{ kg}$ | Inverter batteries, 10-ft PVC pipe bundles, submersible motors |

---

## 2. Dispatch Matching & Broadcast Algorithm

```
[Order Packed & Handover Token Generated]
                     │
                     ▼
[Calculate Order Total Weight & Dimensions]
                     │
                     ▼
[Filter Active Online Riders in Zone]
- Duty status == 'ONLINE'
- Phone battery >= 15%
- Floating cash < ₹2,500
- Vehicle payload capacity >= Order Weight
- Rider within 3.0 km radius of Merchant Hub
                     │
                     ▼
[Rank Candidates by Distance, Rating, Shift Tier]
                     │
                     ▼
[Broadcast Task to Top Candidate (30s Acceptance Timer)]
                     │
          ┌──────────┴──────────┐
          │ (Accepts within 30s)│ (Rejects or Times Out)
          ▼                     ▼
[Atomic CAS Claim]     [Cascade to Next Best Candidate]
```

### 2.1 Concurrency-Safe Batch Claiming (CWE-362 Remediation)
```typescript
export async function claimBatchAtomically(batchId: string, riderId: string) {
  // Atomic compare-and-swap update ensures only one rider can claim a broadcasted batch
  const result = await db.query(
    `UPDATE delivery_trips 
     SET rider_id = $1, status = 'ACCEPTED', accepted_at = NOW() 
     WHERE id = $2 AND rider_id IS NULL 
     RETURNING *`,
    [riderId, batchId]
  );
  if (result.rowCount === 0) {
    throw new ConcurrencyConflictError('Batch already claimed by another delivery partner.');
  }
  return result.rows[0];
}
```

---

## 3. Delivery Economics & Authoritative Distance Calculation

### 3.1 Distance Rounding Formula
To guarantee deterministic, transparent, and auditable pricing across all platforms, distances are rounded to the nearest 100 meters:
$$\text{rounded\_distance\_m} = \left\lfloor \frac{\text{actual\_distance\_m} + 50}{100} \right\rfloor \times 100$$

### 3.2 Rider Fare Structure
- **Base Fare**: ₹35.00 (covers pickup and first 2.0 km).
- **Distance Pay**: ₹8.00 per km for distance beyond 2.0 km.
- **Transit Time Pay**: ₹0.50 per minute of estimated road travel.
- **Surge Multiplier**: Applied to base + distance fare during peak shift hours (1.20x to 1.50x).
- **Wait-Time Pay**: ₹1.20 per minute after 5 minutes of store packing delay.
- **Customer Tip**: 100% passed through directly to the delivery partner.

---

## 4. GPS Anti-Spoofing & Battery Telematics

- **Endpoint**: `POST /api/qrider/telemetry/location`
- **Velocity Sanity Check (CWE-20 Remediation)**:
  - Calculates physical speed between successive GPS pings:
    $$v = \frac{\text{HaversineDistance}(P_1, P_2)}{\Delta t}$$
  - If $v > 120\text{ km/h}$, the telemetry packet is rejected with HTTP 422 (`GPS velocity sanity check failed: impossible velocity detected`).
- **Low Battery Auto-Offline Interlock**:
  - When battery $< 15\%$ without active charger, rider receives a 10-minute warning before the system flips their duty status to `OFFLINE`.

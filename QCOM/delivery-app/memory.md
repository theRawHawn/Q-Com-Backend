# Persistent Project Memory & Architectural Decisions

## Key Architectural Decisions
1. **Canonical Order Lifecycle**:
   - Order Statuses: `placed` -> `picking` -> `packed` -> `out_for_delivery` -> `arriving` -> `delivered`.
   - Partner active statuses: `offline` | `idle_at_hub` | `picking_up` | `in_transit` | `arrived_at_drop`.
2. **Delivery Payout Economics**:
   - Aligned with Customer App's `deliveryEconomicsService`: Base payout ₹35 (covers first 2km), +₹8/km beyond 2km, +₹0.5/min transit time, +₹15 surge/peak bonus, 100% customer tip pass-through.
3. **Customer Privacy Protection**:
   - Phone numbers exposed to delivery partners use QCOM IVR proxy masking (e.g. `+91 98XXX-XX891`) with click-to-call proxy trigger.
4. **Interactive Navigation**:
   - Interactive leaflet/canvas map rendering route polylines, pickup store entrance marker, customer dropoff entrance marker, turn instructions, and simulated real-time GPS movement.
5. **Backend-Ready Service Contracts**:
   - UI consumes service interfaces (`deliveryTaskService`, `earningsService`, etc.) backed by `mockData.ts` to allow seamless swap with real Express/Node backend APIs in the future.
6. **Master PRD & Distributed System Architecture (v2.0)**:
   - Full 7-module technical specification and architecture blueprint established in `product.md` and `architect.md`.
   - Microservices topology: Auth, KYC/BGV, Telemetry, Dispatch & Match, Gig Capacity, Order Lifecycle, Finance & Floating Cash, Safety/SOS.
   - Core data models, state machines, Redis atomic locks, and Kafka event bus schemas codified.
7. **v2.0.0 Production-Ready Frontend Execution**:
   - Multi-mode delivery verification implemented: 4-digit PIN OTP, Contactless Photo Proof with EXIF & GPS watermark overlay, and Cash on Delivery (COD) collection with dynamic change calculator.
   - Floating cash ceiling (₹2,500 max liability) tracked with instant UPI remittance modal and balance deduction.
   - Customer unreachable protocol enforcing a mandatory 5-minute countdown, automated IVR pings, and authorized return trip to Seller Store with 100% fare + ₹25 return trip compensation.
   - Store packing delay reporting starting a live wait-time compensation meter (₹1.20/min past 5 min).
   - Performance Scorecard with Bronze/Silver/Gold/Platinum tiers, completion rate tracking, on-time rate, and priority dispatch perks.
   - Digital KYC & Asset Management section with Aadhaar/DL/RC/BGV status, vehicle payload constraints, and mandatory training modules.
   - Dedicated Gig Shift Booking view with peak hour surge indicators, time slot selection, and geo-attendance check-in.
   - Masked Telephony IVR bridge modal with zero personal phone exposure.
8. **Theme & Header Design Specification**:
   - Retained dark slate `#3e4452` styling exclusively on the sticky top header bar matching the production quick-commerce partner layout, with built-in smooth scroll-to-top interaction.
   - Branded as `Qcom Delivery partner` in the header bar, metadata, and HTML title.
   - All other views, modals, cards, maps, navigation flows, and interactive components strictly follow the clean, high-contrast light theme with zero dark mode styles.
9. **Zero-API-Key OpenStreetMap & OSRM Routing Engine**:
   - Adopted the exact OpenStreetMap tile provider (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`) and OSRM routing engine from the Customer App repository (`Q-commerce/src/components/OpenStreetMap.tsx`), completely eliminating 3rd-party tile API keys (CartoDB watermarks) and external map charges.
10. **Delivery Partner Separation of Concerns & Customer Privacy**:
   - Removed individual order product lists from the partner interface. Store staff pack and seal items into tamper-evident bags.
   - Partner workflow focuses strictly on two verifications:
     1. **Pickup with Seller Verification**: Show store handover token (e.g. `PK-8819`), confirm sealed bag count and intact tamper-evident seal.
     2. **Deliver to Customer with OTP Verification**: Direct 4-digit PIN verification requested from customer on arrival.
11. **Domain Specialization (Hardware & Automobile Parts)**:
   - The QCOM ecosystem is specialized for Hardware (kitchen, bath, plumbing, carpentry, electrical) and Automobile Parts (cars, bikes, autos, and other vehicles).
   - Vehicle constraints, shift logistics, delivery equipment, safety training modules, and task profiles reflect heavy-duty tools, spare parts, plumbing fixtures, and vehicle accessories.
12. **Operating Hours & 12-Hour Time Format**:
   - App/Seller Operating Hours: 08:00 AM – 08:00 PM across 4 structured slots of 3 hours each:
     1. Morning Contractor & Site Rush: 08:00 AM – 11:00 AM
     2. Midday Workshop & Garage Peak: 11:00 AM – 02:00 PM
     3. Afternoon Express Spares Run: 02:00 PM – 05:00 PM
     4. Evening Maintenance & Repair Surge: 05:00 PM – 08:00 PM
   - All operational times across UI, data models, earnings logs, and documentation are strictly formatted in 12-hour AM/PM format.
   - Completely eradicated all traces of dark store terminology across the entire repository.


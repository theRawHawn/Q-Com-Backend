# SPRINT 15.6 — EXECUTIVE SUMMARY FOR THE FOUNDER

**Project:** QCOM (Quick Commerce Hardware & Trade Marketplace)
**Date / Baseline:** Commit `c384268da1d0f24a93aaf86215b18ead5a56b1fa`
**Verdict:** **`NOT READY FOR REAL TRANSACTIONS`**

---

> **Read This First — The Honest Truth About the "56/56 Green Tests"**:
> You may have seen reports that all 56 backend test suites passed in GitHub Actions. That is true—**but it does not mean QCOM is ready for real customers or real money.**
> Think of it like testing an airplane inside a flight simulator with no jet engines installed: the cockpit switches, seatbelts, and dashboard gauges work cleanly in the simulator (`mock` mode), **but if you try to turn the real key in production today, the engines aren't connected yet and the system crashes on startup.**

---

## 1. What Is QCOM's Backend Capable of Doing Today? (What Is Actually Working)

Your engineering team has built a **genuinely strong internal foundation** in several hard areas that usually trip up early startups:
- **Anti-Overselling Stock Locks:** If two customers click "Buy Now" at the exact same millisecond on the last drill or pipe valve in a hardware store, the database locks the item row like a physical turnstile—only one customer gets it, and the other gets a clean "Out of Stock" error.
- **Double-Entry Financial Bookkeeping (General Ledger):** Like an accountant's balanced ledger book, QCOM tracks every rupee in two columns (Debits = Credits) and refuses to save any financial entry that doesn't balance to zero. It also prevents duplicate webhook events or double-payout button clicks from paying twice.
- **Hardened Login & Permissions Security:** Admin passwords use strong encryption (`scrypt`), login tokens rotate safely so stolen tokens trigger an instant alarm across all servers, and lower-level staff cannot promote themselves to Super Admin.
- **Local Merchant Marketplace Design:** QCOM does **not** force you into expensive dark stores. The database already models independent local hardware/trade shops, their individual prices, bin locations, and delivery riders nearby.

---

## 2. What Is Incomplete, Broken, or Dangerous Right Now?

### The "Fake / Disconnected Wires" (Will Crash or Lose Money Immediately)
1. **No Real Connections to the Outside World:**
   - **Payments (Razorpay):** The "Razorpay" connector inside the code is actually an empty placeholder using temporary memory—it never talks to Razorpay's servers. In production mode, payments are disabled.
   - **Bank Payouts (RazorpayX) & Login SMS (OTPs) & Mobile Push Notifications:** None of these are wired to real vendors yet. In fact, if you set `NODE_ENV=production` right now, **the backend crashes immediately on startup** because those connectors throw an intentional safety error warning that no real SMS/Payout/Push vendor exists.
2. **Broken Delivery-to-Wallet / Cash-on-Delivery (COD) Wiring:**
   - When a delivery rider confirms delivery OTP through the partner app endpoint, the system marks the order "Delivered"—**and then stops.** It forgets to credit the seller's wallet ledger, forgets to record that the rider is now holding Cash-on-Delivery money, forgets to mark the COD order as paid, and forgets to mark the rider as free for the next delivery. Plus, a rider can skip "Picked Up" and mark an order delivered immediately, or go "Offline" mid-delivery!
3. **Sellers Could Drain Money Immediately:**
   - Right now, a seller could have an order marked delivered and immediately trigger a bank withdrawal **with zero waiting period** for returns, **no merchant payout freeze switch** for fraud, and **no admin approval cap**. If the customer later demands a refund, QCOM eats the loss.
4. **Unlimited Coupon Reuse & Admin Screen Mirage:**
   - Coupons have a `usage_limit` column in the database, but the pricing calculator **never checks or increases it**—a `1-use` promo code can be reused 10,000 times. And the admin "Create Promotion" endpoint uses wrong column names and crashes on real PostgreSQL.
   - Worse, several Admin Portal buttons (**Approve/Reject/Retry Refunds**, **Edit Seller**, **Adjust Stock**, **Fraud Controls**, **Support Tickets**, **Admin Settlements Screen**) are hollow placeholders: they return "Success!" to the screen while either writing only a log note or showing a fake flat 85% estimate instead of actual seller balances. Creating a new admin employee through the compatibility route creates an account with no password that can never log in.
5. **Cancellation Traffic Jam Risk:**
   - When a customer cancels a paid order, the system locks that order row in the database *and waits* while calling the payment gateway to issue a refund (including retry wait timers). If the payment gateway slows down for 3 seconds during busy hours, all 20 database connections can clog up and freeze checkout for everyone else.
6. **Zero Database Backups:**
   - There are no automated database backup scripts, Point-In-Time Recovery rules, or restore tests in the repository. A serious database mistake or crash would lose financial history.

---

## 3. Clear Answers to Your 14 Founder Questions

### 1. What is missing for Customers?
- Real SMS OTP login (won't send SMS today).
- Real UPI/Card payment processing (Razorpay stub only).
- A saved shopping cart in the database (if they close the app, the backend doesn't hold their cart yet).
- Store radius and shop-opening-hours checks (customers can currently place orders at closed shops or miles outside the delivery radius).
- Proper PDF tax invoices (right now the backend generates plain text with hardcoded "Karnataka (29)" and fake government IRN codes—plus no GST Credit Notes on returns).
- Real customer support tickets, return refund tax/discount proration, and privacy/account-deletion tools (India DPDP).

### 2. What is missing for Merchants (Local Shop Owners)?
- A way to register online and upload/verify PAN, GSTIN, and Bank Account details ("penny-drop" verification).
- API endpoints for shop owners to add products, change prices, or edit catalog details themselves.
- Working store-hour enforcement and fair penalty rules (currently, any store with default 8-minute prep time gets fined ₹25 automatically on every order instead of checking if they were actually late!).
- Return cooling-off hold rules + verified bank gates before payouts, real settlement dashboards, and dispute tools.

### 3. What is missing for Delivery Partners?
- Registration & KYC document checks (Driving License, Vehicle RC, PAN, Bank/UPI verification).
- Properly wired OTP delivery completion that records COD cash owed, credits rider earnings, and frees them for the next trip.
- Real road-map ETAs (currently straight-line distance × 1.25—ignores rivers, one-ways, and traffic) and excluding riders whose GPS signal is missing rather than pretending they are standing inside the shop.
- Working reverse-pickup trips for returns (right now return pickup overwrites the original forward trip record!) and an in-app SOS safety button.

### 4. What is missing for Administrators?
- Replacing all fake "200 OK" admin buttons (refunds, disputes, stock adjustments, seller updates, fraud flags, support tickets) with real database-backed actions.
- Fixing Admin Employee creation so created staff actually have passwords to log in.
- Fixing the Admin Settlement report so it reads the real double-entry ledger instead of guessing `order_total × 0.85`.
- Approval limits (e.g., dual sign-off before releasing large refunds/payouts), emergency city pause switches, and live monitoring/alerts when things fail.

### 5. What MUST be completed before we accept real money?
*(Stage A — Non-negotiable)*
1. Wire real Razorpay/Cashfree Payments, RazorpayX/Cashfree Payouts, SMS OTP (with India DLT templates), and FCM Push Notifications—and test in vendor sandboxes.
2. Fix the partner delivery completion route so delivery -> seller allocation -> rider pay -> COD cash liability -> rider idle reset all happen atomically.
3. Move external gateway refund calls **outside** database row locks during cancellation.
4. Put return-window cooling-off holds, verified bank checks, and merchant freeze switches on payouts.
5. Fix coupon `usage_limit` enforcement, the SGST tax calculation typo, broken admin refund/settlement endpoints, and enforce strict order state transitions.
6. Turn on Managed PostgreSQL automated backups + Point-In-Time Recovery + test restoring a backup.

### 6. What MUST be completed before onboarding external merchants?
- Self-serve onboarding + KYC document collection + automated PAN/GSTIN/Bank penny-drop verification.
- Seller-facing product & price management endpoints and real admin stock/seller edits.
- Enforcing store operating hours and delivery radius limits accurately (plus multi-item store availability check).

### 7. What MUST be completed before the first real customer pilot order?
- Everything above, plus: persistent server-side carts, working reverse-pickup trip records for returns, compliant binary PDF tax invoices & Credit Notes, standalone deployment packaging fix (`ioredis` added to `QCOM/backend/package.json`), real road distance routing, Managed Redis HA + cloud monitoring/alerts (Sentry/metrics).

### 8. What MUST be completed before public launch?
- Real support ticketing & dispute workflows, active COD/fraud blocks enforced at checkout, WhatsApp & Email transactional alerts, India DPDP consent + data export + account-anonymization workflow, and real load testing to verify how many orders/second the server handles without stalling.

### 9. What should we do next?
- **Engineering:** Execute **Roadmap Sprint 1** (connect real Razorpay, RazorpayX, SMS OTP, and FCM Push adapters in sandbox) and immediately follow with **Roadmap Sprint 2** (fix delivery-to-ledger/COD, cancellation lock safety, payout holds).
- **Founder (External Actions — Start Today because Telecom/Bank KYC takes 1–2 weeks!):** Start Razorpay + RazorpayX merchant KYC, India telecom **DLT SMS registration**, Firebase project setup, cloud database account (AWS/GCP), and engage a Chartered Accountant on GST/TCS/TDS treatment.

### 10. What can wait until later (Post-Launch)?
- Complex product variants & automobile spare-parts fitment catalogs, automated monthly GSTR/26Q accounting file exports, customer ratings & reviews, and Google/Apple OAuth login (Phone OTP covers launch).

---

**Bottom Line:** You do **not** need to throw away what has been built or rebuild from scratch. The hardest internal engine pieces (stock locking, security tokens, and balanced double-entry accounting) are already built. Now QCOM needs **6 focused, disciplined engineering sprints** to connect real payment/SMS/payout rails, close 8 critical financial/wiring gaps, add merchant/rider onboarding, and set up backups & monitoring before taking a single real rupee.

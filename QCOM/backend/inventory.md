# QCOM Seller Marketplace Availability & Store Fulfilment Specification

**Platform Model:** Seller-Owned Marketplace & Aggregator Platform  
**Fulfilment Mechanism:** Seller-Side Store Fulfilment with Merchant Order Acceptance  
**No Centralized Inventory:** QCOM does NOT own, warehouse, reserve, or consume seller inventory.

---

## 1. Product Ownership & Catalogue Model

In the QCOM architecture, hardware and industrial products belong exclusively to independent merchants:

- **Seller Authority:** The merchant is the sole authority over their product catalogue, SKUs, product titles, descriptions, selling prices, HSN codes, GST rates, and active availability.
- **Store-Level Availability:** The `store_inventory` table serves solely as a **seller-managed availability representation** (`is_available`, seller-indicated stock count, physical bin location for packing staff).
- **Zero QCOM Inventory Ownership:** QCOM never holds dark-store stock, never issues purchase orders for seller goods, and never performs inventory valuation on merchant products.

---

## 2. Order Checkout & Availability Verification

QCOM follows modern quick-commerce semantics:

$$\text{Browse} \longrightarrow \text{Product} \longrightarrow \text{Add to Cart} \longrightarrow \text{Cart} \longrightarrow \text{Checkout} \longrightarrow \text{Pay} \longrightarrow \text{Place Order}$$

1. **No Checkout Stock Decrement:** When a customer creates a cart or proceeds through checkout, QCOM does **not** lock or decrement seller inventory.
2. **Availability Check:** The pricing and checkout engine verifies that the requested items are marked `is_available = true` by the seller.
3. **Seller Order Acceptance:** Once an order is placed, it is dispatched to the merchant's store terminal for physical acceptance and packing. If the merchant cannot fulfil the order, the merchant rejects or modifies the order according to marketplace protocol.

---

## 3. Physical Packing & Bin Mapping

For merchant store staff efficiency, physical bin coordinates (e.g. `Aisle 2 · Bin E-04`) assist seller pickers in locating products within their own retail hardware stores:

```json
{
  "productId": "prod-elec-01",
  "sku": "ANC-ROM-6A-1W",
  "name": "Anchor Roma 6A 1-Way Modular Switch",
  "binLocation": "Aisle 2 · Bin E-04",
  "isAvailable": true
}
```

import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/testDb.js';
import { runMigrations } from '../src/database/migrator.js';
import { runSeeds } from '../seeds/seedData.js';

export async function testSeeds() {
  console.log('\n--- Running Database Seeds Test Suite ---');
  const { pool } = createTestDatabase();

  try {
    await runMigrations({ poolOverride: pool });
    await runSeeds(pool);

    // 1. Roles Verification
    const rolesRes = await pool.query('SELECT code, name FROM roles ORDER BY code');
    assert.ok(rolesRes.rows.length >= 8, 'Expected at least 8 seeded roles');
    const roleCodes = rolesRes.rows.map(r => r.code);
    assert.ok(roleCodes.includes('SUPER_ADMIN'));
    assert.ok(roleCodes.includes('STORE_OWNER'));
    assert.ok(roleCodes.includes('STORE_MANAGER'));
    assert.ok(roleCodes.includes('STAFF_PACKER'));
    assert.ok(roleCodes.includes('RIDER'));
    assert.ok(roleCodes.includes('CUSTOMER'));
    console.log(`✓ Verified ${rolesRes.rows.length} platform roles initialized`);

    // 2. Permissions Verification
    const permRes = await pool.query('SELECT key, module FROM permissions');
    assert.ok(permRes.rows.length >= 25, 'Expected at least 25 granular permissions');
    const rpRes = await pool.query('SELECT role_id, permission_id FROM role_permissions');
    assert.ok(rpRes.rows.length >= 30, 'Expected role permission mappings seeded');
    console.log(`✓ Verified ${permRes.rows.length} granular permissions and ${rpRes.rows.length} role-permission grants`);

    // 3. Chart of Accounts (COA) Verification
    const coaRes = await pool.query('SELECT account_code, account_name, category, normal_balance FROM general_ledger_accounts ORDER BY account_code');
    assert.ok(coaRes.rows.length >= 15, 'Expected at least 15 Chart of Accounts');
    
    // Validate Asset accounts have DEBIT normal balance
    const assets = coaRes.rows.filter(a => a.category === 'ASSET');
    for (const a of assets) {
      assert.equal(a.normal_balance, 'DEBIT', `Asset account ${a.account_code} must have normal balance DEBIT`);
    }

    // Validate Liability & Revenue accounts have CREDIT normal balance
    const credits = coaRes.rows.filter(a => a.category === 'LIABILITY' || a.category === 'REVENUE');
    for (const c of credits) {
      assert.equal(c.normal_balance, 'CREDIT', `Liability/Revenue account ${c.account_code} must have normal balance CREDIT`);
    }
    console.log(`✓ Verified ${coaRes.rows.length} double-entry General Ledger Chart of Accounts with accounting balance rules`);

    // 4. Statutory Tax Rules (HSN/SAC) Verification
    const taxRes = await pool.query('SELECT rule_code, hsn_or_sac_code, gst_rate_percent FROM statutory_tax_rules ORDER BY rule_code');
    assert.ok(taxRes.rows.length >= 9, 'Expected at least 9 statutory tax rules');
    const autoPartRule = taxRes.rows.find(r => r.hsn_or_sac_code === '8708');
    assert.ok(autoPartRule, 'HSN 8708 rule must exist');
    assert.equal(Number(autoPartRule.gst_rate_percent), 28.00, 'HSN 8708 automotive spares GST rate must be 28%');
    console.log(`✓ Verified ${taxRes.rows.length} HSN/SAC statutory tax rules (including HSN 8708 @ 28% and HSN 8481 @ 18%)`);

    // 5. Statutory Withholding Rules (2026 Direct Tax Regime - Income-tax Act 2025 Section 393)
    const wthRes = await pool.query('SELECT rule_code, governing_law, statutory_provision, table_item, applicable_rate_percent, pan_status FROM statutory_withholding_rules');
    assert.ok(wthRes.rows.length >= 5, 'Expected at least 5 versioned withholding rules');
    
    const ecomRule = wthRes.rows.find(r => r.governing_law === 'INCOME_TAX_ACT_2025' && r.table_item === 'TABLE_8_V' && r.pan_status === 'VALID_PAN');
    assert.ok(ecomRule, 'Income-tax Act, 2025 Section 393 Table 8(v) e-commerce participant rule must exist');
    assert.equal(Number(ecomRule.applicable_rate_percent), 0.100, 'E-commerce participant withholding rate must be 0.100%');

    const penalRule = wthRes.rows.find(r => r.governing_law === 'INCOME_TAX_ACT_2025' && r.pan_status === 'INVALID_OR_MISSING_PAN');
    assert.ok(penalRule, 'Higher-rate withholding rule for missing/invalid PAN must be versioned in database');
    assert.equal(Number(penalRule.applicable_rate_percent), 5.000, 'Section 393 higher withholding rate for missing PAN must be 5.000%');
    console.log('✓ Verified 2026 Direct Tax Regime (Income-tax Act, 2025 Section 393 Table 8(v) @ 0.1% and higher rate resolution)');

    // 6. Section 52 GST-TCS Rules
    const tcsRes = await pool.query('SELECT rule_code, integrated_rate_percent, reporting_form FROM gst_tcs_rules');
    assert.ok(tcsRes.rows.length >= 1, 'Expected at least 1 GST-TCS rule');
    assert.equal(Number(tcsRes.rows[0].integrated_rate_percent), 0.500, 'GST-TCS integrated rate must be 0.5% (0.25% CGST + 0.25% SGST)');
    assert.equal(tcsRes.rows[0].reporting_form, 'GSTR-8');
    console.log('✓ Verified Section 52 GST-TCS statutory rules for GSTR-8 reporting');

    // 7. Demo Merchant & Catalog Inventory
    const merchRes = await pool.query('SELECT merchant_code, gstin, status FROM merchants');
    assert.ok(merchRes.rows.length >= 1);
    const primaryMerch = merchRes.rows.find(m => m.merchant_code === 'MERCH-BLR-01');
    assert.ok(primaryMerch);
    assert.equal(primaryMerch.status, 'ACTIVE');

    const invRes = await pool.query(`
      SELECT p.sku, p.name, si.selling_price, si.stock_count, si.bin_location 
      FROM store_inventory si 
      JOIN products p ON si.product_id = p.id
    `);
    assert.ok(invRes.rows.length >= 4, 'Expected at least 4 demo inventory items seeded');
    console.log(`✓ Verified Demo Merchant, Store, and ${invRes.rows.length} localized inventory fixtures with bin locations`);

    // 8. Demo Delivery Partner & Customer Profile
    const riderRes = await pool.query('SELECT rider_code, name, status, kyc_status FROM riders');
    assert.ok(riderRes.rows.length >= 1);
    assert.equal(riderRes.rows[0].status, 'IDLE_AT_HUB');

    const userRes = await pool.query('SELECT phone, name, account_type FROM users WHERE phone = $1', ['+91-9876543210']);
    assert.equal(userRes.rows.length, 1);
    assert.equal(userRes.rows[0].account_type, 'business');

    const gstinRes = await pool.query('SELECT gstin, legal_business_name FROM saved_gstins');
    assert.ok(gstinRes.rows.length >= 1);
    assert.equal(gstinRes.rows[0].gstin, '29AABCS1429B1Z8');
    console.log('✓ Verified Demo Delivery Partner (KYC GREEN) and Customer B2B Profile (GSTIN saved)');

  } finally {
    await pool.end();
  }
}

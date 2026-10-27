import pg from 'pg';
import { getPool } from '../src/database/connection.js';

export async function runSeeds(poolOverride?: pg.Pool): Promise<void> {
  const pool = poolOverride || getPool();
  console.log('[Seeds] Seeding initial development fixtures...');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. System Roles
    console.log('[Seeds] Seeding roles...');
    const roles = [
      { code: 'SUPER_ADMIN', name: 'Super Administrator', description: 'Full platform governance, security and configuration', isSystem: true },
      { code: 'OPERATIONS', name: 'Operations Manager', description: 'Real-time order management, dispatch and fleet operations', isSystem: true },
      { code: 'DISPATCHER', name: 'Fleet Dispatcher', description: 'Real-time order dispatch and rider operations', isSystem: true },
      { code: 'FINANCE_ADMIN', name: 'Finance Administrator', description: 'Settlements, refunds, and ledger audits', isSystem: true },
      { code: 'STORE_OWNER', name: 'Store Owner', description: 'Merchant store administration, catalog and finance', isSystem: true },
      { code: 'STORE_MANAGER', name: 'Store Manager', description: 'Order packing, catalog, and inventory control', isSystem: true },
      { code: 'STAFF_PACKER', name: 'Staff Picker / Packer', description: 'Picking and physical rider handovers', isSystem: true },
      { code: 'RIDER', name: 'Delivery Partner', description: 'Fleet delivery gig partner', isSystem: true },
      { code: 'CUSTOMER', name: 'Customer / Contractor', description: 'Commercial buyer or retail client', isSystem: true },
    ];
    for (const r of roles) {
      await client.query(
        `INSERT INTO roles (code, name, description, is_system_role, updated_at) 
         VALUES ($1, $2, $3, $4, NOW()) 
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, is_system_role = EXCLUDED.is_system_role`,
        [r.code, r.name, r.description, r.isSystem]
      );
    }

    // 2. Granular Permissions
    console.log('[Seeds] Seeding Granular Permissions...');
    const permissions = [
      { key: 'dashboard.view', module: 'dashboard', name: 'View Dashboard', desc: 'View operational metrics' },
      { key: 'orders.view', module: 'orders', name: 'View Orders', desc: 'View order lists and details' },
      { key: 'orders.create', module: 'orders', name: 'Create Orders', desc: 'Place new orders' },
      { key: 'orders.edit', module: 'orders', name: 'Edit Orders', desc: 'Modify order items' },
      { key: 'orders.update_status', module: 'orders', name: 'Update Order Status', desc: 'Transition order state' },
      { key: 'orders.assign_rider', module: 'orders', name: 'Assign Rider', desc: 'Assign delivery partner' },
      { key: 'orders.cancel', module: 'orders', name: 'Cancel Order', desc: 'Cancel placed order' },
      { key: 'orders.refund', module: 'orders', name: 'Refund Order', desc: 'Initiate order refund' },
      { key: 'customers.view', module: 'customers', name: 'View Customers', desc: 'View customer accounts' },
      { key: 'customers.edit', module: 'customers', name: 'Edit Customers', desc: 'Modify customer account' },
      { key: 'customers.suspend', module: 'customers', name: 'Suspend Customer', desc: 'Suspend abusive customer' },
      { key: 'sellers.view', module: 'sellers', name: 'View Sellers', desc: 'View merchant stores' },
      { key: 'sellers.create', module: 'sellers', name: 'Create Seller', desc: 'Onboard new merchant' },
      { key: 'sellers.edit', module: 'sellers', name: 'Edit Seller', desc: 'Modify merchant profile' },
      { key: 'sellers.approve', module: 'sellers', name: 'Approve Seller', desc: 'Approve KYC for merchant' },
      { key: 'sellers.suspend', module: 'sellers', name: 'Suspend Seller', desc: 'Suspend merchant store' },
      { key: 'riders.view', module: 'riders', name: 'View Riders', desc: 'View delivery partners' },
      { key: 'riders.onboard', module: 'riders', name: 'Onboard Rider', desc: 'Register delivery partner' },
      { key: 'riders.approve_kyc', module: 'riders', name: 'Approve Rider KYC', desc: 'Verify rider documents' },
      { key: 'riders.suspend', module: 'riders', name: 'Suspend Rider', desc: 'Suspend delivery partner' },
      { key: 'riders.broadcast', module: 'riders', name: 'Broadcast to Riders', desc: 'Send fleet notifications' },
      { key: 'riders.payout', module: 'riders', name: 'Release Rider Payout', desc: 'Disburse wallet earnings' },
      { key: 'inventory.view', module: 'inventory', name: 'View Inventory', desc: 'Inspect stock and bins' },
      { key: 'inventory.edit_stock', module: 'inventory', name: 'Update Stock Count', desc: 'Modify stock quantity' },
      { key: 'settlements.view', module: 'settlements', name: 'View Settlements', desc: 'Inspect merchant payouts' },
      { key: 'settlements.process', module: 'settlements', name: 'Process Settlements', desc: 'Disburse merchant funds' },
      { key: 'refunds.view', module: 'refunds', name: 'View Refunds', desc: 'Inspect refund claims' },
      { key: 'refunds.approve', module: 'refunds', name: 'Approve Refund', desc: 'Authorize refund payment' },
      { key: 'service_areas.view', module: 'service_areas', name: 'View Service Areas', desc: 'Inspect zones' },
      { key: 'service_areas.manage', module: 'service_areas', name: 'Manage Service Areas', desc: 'Configure zones' },
      { key: 'pricing.view', module: 'pricing', name: 'View Pricing Rules', desc: 'Inspect fee slabs' },
      { key: 'pricing.manage', module: 'pricing', name: 'Manage Pricing Rules', desc: 'Modify fee slabs' },
      { key: 'audit.view', module: 'audit', name: 'View Audit Logs', desc: 'Inspect immutable audit logs' },
      { key: 'rbac.view', module: 'rbac', name: 'View Roles & Permissions', desc: 'Inspect RBAC structure' },
      { key: 'rbac.manage', module: 'rbac', name: 'Manage Roles & Permissions', desc: 'Modify roles and grants' },
    ];

    for (const p of permissions) {
      await client.query(
        `INSERT INTO permissions (key, module, name, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
        [p.key, p.module, p.name, p.desc]
      );
    }

    // 3. Map Role Permissions
    console.log('[Seeds] Mapping Role Permissions...');
    const allPermRes = await client.query('SELECT id, key FROM permissions');
    const permMap = new Map<string, string>();
    allPermRes.rows.forEach(r => permMap.set(r.key, r.id));

    const allRoleRes = await client.query('SELECT id, code FROM roles');
    const roleMap = new Map<string, string>();
    allRoleRes.rows.forEach(r => roleMap.set(r.code, r.id));

    const rolePermissionGrants: Record<string, string[]> = {
      SUPER_ADMIN: Array.from(permMap.keys()),
      OPERATIONS: ['dashboard.view', 'orders.view', 'orders.update_status', 'orders.assign_rider', 'customers.view', 'sellers.view', 'riders.view', 'riders.broadcast', 'service_areas.view'],
      DISPATCHER: ['dashboard.view', 'orders.view', 'orders.update_status', 'orders.assign_rider', 'riders.view', 'riders.broadcast', 'service_areas.view'],
      FINANCE_ADMIN: ['dashboard.view', 'settlements.view', 'settlements.process', 'refunds.view', 'refunds.approve', 'audit.view'],
      STORE_OWNER: ['orders.view', 'orders.update_status', 'inventory.view', 'inventory.edit_stock', 'settlements.view'],
      STORE_MANAGER: ['orders.view', 'orders.update_status', 'inventory.view', 'inventory.edit_stock'],
      STAFF_PACKER: ['orders.view', 'orders.update_status'],
      RIDER: ['orders.view', 'riders.view'],
      CUSTOMER: ['orders.view', 'orders.create'],
    };

    for (const [roleCode, permKeys] of Object.entries(rolePermissionGrants)) {
      const roleId = roleMap.get(roleCode);
      if (!roleId) continue;
      for (const pKey of permKeys) {
        const permId = permMap.get(pKey);
        if (permId) {
          await client.query(
            `INSERT INTO role_permissions (role_id, permission_id)
             VALUES ($1, $2)
             ON CONFLICT (role_id, permission_id) DO NOTHING`,
            [roleId, permId]
          );
        }
      }
    }

    // 4. Chart of Accounts (COA) - Double-Entry Ledger
    console.log('[Seeds] Seeding Chart of Accounts (COA)...');
    const accounts = [
      { code: '1010', name: 'Cash at Payment Gateway (Escrow)', category: 'ASSET', normal: 'DEBIT', desc: 'Customer funds held at gateway before order delivery' },
      { code: '1020', name: 'Bank Operating Account', category: 'ASSET', normal: 'DEBIT', desc: 'Primary platform corporate disbursement account' },
      { code: '1030', name: 'Floating Cash in Hands of Riders (COD)', category: 'ASSET', normal: 'DEBIT', desc: 'Cash collected by riders on physical deliveries' },
      { code: '1040', name: 'Merchant Receivable (Clawbacks & Returns)', category: 'ASSET', normal: 'DEBIT', desc: 'Unrecovered balances owed by merchants due to post-payout returns' },
      { code: '2010', name: 'Customer Funds Held in Escrow', category: 'LIABILITY', normal: 'CREDIT', desc: 'Liability to deliver goods or refund customer' },
      { code: '2020', name: 'Merchant Accounts Payable', category: 'LIABILITY', normal: 'CREDIT', desc: 'Net balance owed to merchant stores' },
      { code: '2030', name: 'Delivery Partner Wallet Payable', category: 'LIABILITY', normal: 'CREDIT', desc: 'Cleared delivery fares and tips payable to riders' },
      { code: '2040', name: 'GST-TCS Section 52 Payable', category: 'LIABILITY', normal: 'CREDIT', desc: 'Tax Collected at Source payable to Govt via GSTR-8' },
      { code: '2050', name: 'Income-Tax Withholding Payable', category: 'LIABILITY', normal: 'CREDIT', desc: 'E-commerce TDS withheld payable via Form 26Q' },
      { code: '2060', name: 'Logistics Withholding Payable', category: 'LIABILITY', normal: 'CREDIT', desc: 'Contractor TDS withheld payable via Form 26Q' },
      { code: '2070', name: 'Output GST Liability on Platform Fees', category: 'LIABILITY', normal: 'CREDIT', desc: 'GST collected on commission, delivery & handling' },
      { code: '4010', name: 'Marketplace Commission Revenue', category: 'REVENUE', normal: 'CREDIT', desc: 'Earned merchant fee under SAC 9983' },
      { code: '4020', name: 'Customer Delivery Fee Revenue', category: 'REVENUE', normal: 'CREDIT', desc: 'Earned logistics revenue under SAC 9968' },
      { code: '4030', name: 'Convenience & Handling Fee Revenue', category: 'REVENUE', normal: 'CREDIT', desc: 'Platform handling fee under SAC 9985' },
      { code: '5010', name: 'Delivery Rider Logistics Expense', category: 'EXPENSE', normal: 'DEBIT', desc: 'Delivery fare paid to delivery partners' },
      { code: '5020', name: 'Payment Gateway Interchange Fees', category: 'EXPENSE', normal: 'DEBIT', desc: 'Gateway processing costs' },
    ];
    for (const a of accounts) {
      await client.query(
        `INSERT INTO general_ledger_accounts (account_code, account_name, category, normal_balance, description) 
         VALUES ($1, $2, $3, $4, $5) 
         ON CONFLICT (account_code) DO UPDATE SET account_name = EXCLUDED.account_name`,
        [a.code, a.name, a.category, a.normal, a.desc]
      );
    }

    // 5. Statutory Tax Rules (HSN/SAC)
    console.log('[Seeds] Seeding Statutory Tax Rules...');
    const taxRules = [
      { code: 'HSN_7318_FASTENERS', type: 'PRODUCT_GST', codeRef: '7318', desc: 'Fasteners, bolts, nuts and screws', from: '2024-01-01', rate: 18.00, cgst: 9.00, sgst: 9.00, igst: 18.00 },
      { code: 'HSN_8481_VALVES', type: 'PRODUCT_GST', codeRef: '8481', desc: 'Plumbing taps, valves and cocks', from: '2024-01-01', rate: 18.00, cgst: 9.00, sgst: 9.00, igst: 18.00 },
      { code: 'HSN_8536_SWITCHES', type: 'PRODUCT_GST', codeRef: '8536', desc: 'Modular electrical switches and relays', from: '2024-01-01', rate: 18.00, cgst: 9.00, sgst: 9.00, igst: 18.00 },
      { code: 'HSN_8544_CABLES', type: 'PRODUCT_GST', codeRef: '8544', desc: 'Insulated copper cables and wires', from: '2024-01-01', rate: 18.00, cgst: 9.00, sgst: 9.00, igst: 18.00 },
      { code: 'HSN_8708_AUTO_PARTS', type: 'PRODUCT_GST', codeRef: '8708', desc: 'Automotive braking and suspension spares', from: '2024-01-01', rate: 28.00, cgst: 14.00, sgst: 14.00, igst: 28.00 },
      { code: 'HSN_2710_ENGINE_OIL', type: 'PRODUCT_GST', codeRef: '2710', desc: 'Petroleum-based 4T engine lubricants', from: '2024-01-01', rate: 18.00, cgst: 9.00, sgst: 9.00, igst: 18.00 },
      { code: 'SAC_9968_DELIVERY', type: 'DELIVERY_GST', codeRef: '9968', desc: 'Courier & express cargo delivery service', from: '2024-01-01', rate: 18.00, cgst: 9.00, sgst: 9.00, igst: 18.00 },
      { code: 'SAC_9985_HANDLING', type: 'HANDLING_GST', codeRef: '9985', desc: 'Support and handling platform fee', from: '2024-01-01', rate: 18.00, cgst: 9.00, sgst: 9.00, igst: 18.00 },
      { code: 'SAC_9983_COMMISSION', type: 'COMMISSION_GST', codeRef: '9983', desc: 'Marketplace intermediation commission', from: '2024-01-01', rate: 18.00, cgst: 9.00, sgst: 9.00, igst: 18.00 },
    ];
    for (const t of taxRules) {
      await client.query(
        `INSERT INTO statutory_tax_rules 
         (rule_code, tax_type, hsn_or_sac_code, description, effective_from, gst_rate_percent, cgst_rate_percent, sgst_rate_percent, igst_rate_percent, statutory_reference) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CGST_ACT_SCHEDULE') 
         ON CONFLICT (rule_code, effective_from) DO UPDATE SET gst_rate_percent = EXCLUDED.gst_rate_percent`,
        [t.code, t.type, t.codeRef, t.desc, t.from, t.rate, t.cgst, t.sgst, t.igst]
      );
    }

    // 6. Statutory Withholding Rules (Income-tax Act 2025 Section 393 and legacy 1961 rules)
    console.log('[Seeds] Seeding Statutory Withholding Rules (2025 & 1961 regimes)...');
    const withholdingRules = [
      {
        code: 'WTH_2025_SEC393_T8V_IND_VALID_PAN',
        law: 'INCOME_TAX_ACT_2025',
        prov: 'SECTION_393',
        item: 'TABLE_8_V',
        type: 'ECO_SALE_OF_GOODS',
        from: '2026-04-01',
        payee: 'INDIVIDUAL',
        pan: 'VALID_PAN',
        threshSingle: 0,
        threshAnnual: 500000.00,
        rate: 0.100,
        base: 'GROSS_GMV_INCLUDING_TAX',
        form: 'FORM_26Q'
      },
      {
        code: 'WTH_2025_SEC393_T8V_CORP_VALID_PAN',
        law: 'INCOME_TAX_ACT_2025',
        prov: 'SECTION_393',
        item: 'TABLE_8_V',
        type: 'ECO_SALE_OF_GOODS',
        from: '2026-04-01',
        payee: 'COMPANY',
        pan: 'VALID_PAN',
        threshSingle: 0,
        threshAnnual: 0.00,
        rate: 0.100,
        base: 'GROSS_GMV_INCLUDING_TAX',
        form: 'FORM_26Q'
      },
      {
        code: 'WTH_2025_SEC393_T8V_LLP_VALID_PAN',
        law: 'INCOME_TAX_ACT_2025',
        prov: 'SECTION_393',
        item: 'TABLE_8_V',
        type: 'ECO_SALE_OF_GOODS',
        from: '2026-04-01',
        payee: 'FIRM_LLP',
        pan: 'VALID_PAN',
        threshSingle: 0,
        threshAnnual: 0.00,
        rate: 0.100,
        base: 'GROSS_GMV_INCLUDING_TAX',
        form: 'FORM_26Q'
      },
      {
        code: 'WTH_1961_SEC194O_ECO_VALID_PAN',
        law: 'INCOME_TAX_ACT_1961',
        prov: 'SECTION_194_O',
        item: 'SUBSECTION_1',
        type: 'ECO_SALE_OF_GOODS',
        from: '2020-10-01',
        effective_to: '2026-03-31',
        payee: 'ALL',
        pan: 'VALID_PAN',
        threshSingle: 0,
        threshAnnual: 500000.00,
        rate: 0.100,
        base: 'GROSS_GMV_INCLUDING_TAX',
        form: 'FORM_26Q'
      },
      {
        code: 'WTH_2025_SEC393_T8V_PENAL_NO_PAN',
        law: 'INCOME_TAX_ACT_2025',
        prov: 'SECTION_393',
        item: 'TABLE_8_V',
        type: 'ECO_SALE_OF_GOODS',
        from: '2026-04-01',
        payee: 'ALL',
        pan: 'INVALID_OR_MISSING_PAN',
        threshSingle: 0,
        threshAnnual: 0.00,
        rate: 5.000,
        base: 'GROSS_GMV_INCLUDING_TAX',
        form: 'FORM_26Q'
      },
      {
        code: 'WTH_2025_SEC393_LOGISTICS_IND_VALID_PAN',
        law: 'INCOME_TAX_ACT_2025',
        prov: 'SECTION_393',
        item: 'TABLE_LOGISTICS',
        type: 'LOGISTICS_SERVICES',
        from: '2026-04-01',
        payee: 'INDIVIDUAL',
        pan: 'VALID_PAN',
        threshSingle: 30000.00,
        threshAnnual: 100000.00,
        rate: 1.000,
        base: 'RIDER_LOGISTICS_FARE',
        form: 'FORM_26Q'
      },
      {
        code: 'WTH_2025_SEC393_LOGISTICS_PENAL_NO_PAN',
        law: 'INCOME_TAX_ACT_2025',
        prov: 'SECTION_393',
        item: 'TABLE_LOGISTICS',
        type: 'LOGISTICS_SERVICES',
        from: '2026-04-01',
        payee: 'ALL',
        pan: 'INVALID_OR_MISSING_PAN',
        threshSingle: 0.00,
        threshAnnual: 0.00,
        rate: 20.000,
        base: 'RIDER_LOGISTICS_FARE',
        form: 'FORM_26Q'
      },
    ];
    for (const w of withholdingRules) {
      await client.query(
        `INSERT INTO statutory_withholding_rules 
         (rule_code, governing_law, statutory_provision, table_item, withholding_type, effective_from, payee_type, pan_status, threshold_single_txn_inr, threshold_annual_aggregate_inr, applicable_rate_percent, calculation_base, statutory_reporting_form) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) 
         ON CONFLICT (rule_code, effective_from, payee_type, pan_status) DO UPDATE SET applicable_rate_percent = EXCLUDED.applicable_rate_percent`,
        [w.code, w.law, w.prov, w.item, w.type, w.from, w.payee, w.pan, w.threshSingle, w.threshAnnual, w.rate, w.base, w.form]
      );
    }

    // 7. Section 52 GST-TCS Rule
    console.log('[Seeds] Seeding Versioned Section 52 GST-TCS Rules...');
    await client.query(
      `INSERT INTO gst_tcs_rules 
       (rule_code, statutory_provision, effective_from, central_rate_percent, state_rate_percent, integrated_rate_percent, calculation_basis, reporting_form) 
       VALUES ('GST_TCS_2024_NOTIFICATION_15', 'CGST_ACT_SECTION_52', '2024-07-10', 0.250, 0.250, 0.500, 'NET_TAXABLE_SUPPLIES', 'GSTR-8') 
       ON CONFLICT (rule_code, effective_from) DO UPDATE SET integrated_rate_percent = EXCLUDED.integrated_rate_percent`
    );

    // 8. Demo Merchant A & Store A
    console.log('[Seeds] Seeding Demo Merchant A & Store A...');
    const merchantRes = await client.query(
      `INSERT INTO merchants 
       (merchant_code, name, business_name, constitution_type, pan_number, pan_status, locality, address, latitude, longitude, phone, email, gstin, state_code, commission_rate_percent, status, bank_account_number, bank_ifsc, bank_name, bank_account_holder, bank_verified) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) 
       ON CONFLICT (merchant_code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [
        'MERCH-BLR-01',
        'Sri Lakshmi Electricals & Hardware',
        'Sri Lakshmi Commercial Trading LLP',
        'FIRM_LLP',
        'AABCP1429B',
        'VALID_PAN',
        'Koramangala 5th Block',
        '#42, 80 Feet Road, Koramangala 5th Block, Bengaluru 560034',
        12.9352,
        77.6245,
        '+91-9845012345',
        'srilakshmi.hardware@gmail.com',
        '29AABCU9603R1ZM',
        '29',
        15.00,
        'ACTIVE',
        '91234567890123',
        'HDFC0001234',
        'HDFC Bank Ltd',
        'Sri Lakshmi Commercial Trading LLP',
        true
      ]
    );
    const merchantId = merchantRes.rows[0].id;

    await client.query(
      `INSERT INTO merchant_stores 
       (merchant_id, store_code, store_name, is_primary, operating_hours_start, operating_hours_end) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       ON CONFLICT (store_code) DO UPDATE SET store_name = EXCLUDED.store_name`,
      [merchantId, 'STORE-BLR-01', 'Sri Lakshmi Koramangala Hub', true, '08:00:00', '20:00:00']
    );

    // 9. Demo Merchant B (For IDOR & Multi-Tenant Separation Testing)
    console.log('[Seeds] Seeding Demo Merchant B (Tenant B)...');
    const merchantBRes = await client.query(
      `INSERT INTO merchants 
       (merchant_code, name, business_name, constitution_type, pan_number, pan_status, locality, address, latitude, longitude, phone, email, gstin, state_code, commission_rate_percent, status, bank_account_number, bank_ifsc, bank_name, bank_account_holder, bank_verified) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) 
       ON CONFLICT (merchant_code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [
        'MERCH-BLR-02',
        'Kaveri Plumbing & Sanitary Mart',
        'Kaveri Trade Corp India Pvt Ltd',
        'COMPANY',
        'AABCK5544C',
        'VALID_PAN',
        'Indiranagar 100ft Road',
        '#108, 100ft Road, Indiranagar, Bengaluru 560038',
        12.9716,
        77.6412,
        '+91-9845099999',
        'kaveri.plumbing@gmail.com',
        '29AABCK5544C1Z1',
        '29',
        15.00,
        'ACTIVE',
        '99988877766655',
        'ICIC0000002',
        'ICICI Bank Ltd',
        'Kaveri Trade Corp India Pvt Ltd',
        true
      ]
    );
    const merchantBId = merchantBRes.rows[0].id;

    await client.query(
      `INSERT INTO merchant_stores 
       (merchant_id, store_code, store_name, is_primary, operating_hours_start, operating_hours_end) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       ON CONFLICT (store_code) DO UPDATE SET store_name = EXCLUDED.store_name`,
      [merchantBId, 'STORE-BLR-02', 'Kaveri Indiranagar Hub', true, '08:00:00', '20:00:00']
    );

    // 10. Seed Staff for Merchant A and Merchant B
    const sellerAUser = await client.query(
      `INSERT INTO users (phone, name, email, is_phone_verified, account_type, pan_number, pan_status)
       VALUES ($1, $2, $3, TRUE, 'business', 'AABCP1429B', 'VALID_PAN')
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      ['+91-9845012345', 'Suresh Babu (Owner)', 'srilakshmi.hardware@gmail.com']
    );
    const sellerBUser = await client.query(
      `INSERT INTO users (phone, name, email, is_phone_verified, account_type, pan_number, pan_status)
       VALUES ($1, $2, $3, TRUE, 'business', 'AABCK5544C', 'VALID_PAN')
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      ['+91-9845099999', 'Ramesh Kaveri (Owner)', 'kaveri.plumbing@gmail.com']
    );

    const storeOwnerRoleId = roleMap.get('STORE_OWNER');
    if (storeOwnerRoleId) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $2) ON CONFLICT DO NOTHING`,
        [sellerAUser.rows[0].id, storeOwnerRoleId, sellerBUser.rows[0].id]
      );
    }

    await client.query(
      `INSERT INTO store_staff (merchant_id, user_id, name, phone, role, is_active)
       VALUES ($1, $2, 'Suresh Babu', '+91-9845012345', 'STORE_OWNER', TRUE),
              ($3, $4, 'Ramesh Kaveri', '+91-9845099999', 'STORE_OWNER', TRUE)
       ON CONFLICT DO NOTHING`,
      [merchantId, sellerAUser.rows[0].id, merchantBId, sellerBUser.rows[0].id]
    );

    // 11. Demo Products & Store Inventory
    console.log('[Seeds] Seeding Demo Products & Inventory...');
    const demoProducts = [
      {
        sku: 'VALVE-BRASS-05',
        name: '1/2" Heavy Duty Forged Brass Angle Valve',
        category: 'plumbing',
        subcategory: 'valves',
        hsn: '8481',
        gst: 18.00,
        weight: 0.350,
        desc: 'Quarter-turn ceramic disc cartridge, mirror chrome finish, 15mm thread',
        price: 289.00,
        mrp: 350.00,
        stock: 50,
        bin: 'Aisle 3 · Bin P-14B'
      },
      {
        sku: 'SWITCH-ROMA-06A',
        name: 'Anchor Roma 6A 1-Way Modular Switch (White)',
        category: 'electrical',
        subcategory: 'switches',
        hsn: '8536',
        gst: 18.00,
        weight: 0.080,
        desc: 'FR grade polycarbonate, silver cadmium contacts, 240V AC',
        price: 180.00,
        mrp: 220.00,
        stock: 120,
        bin: 'Aisle 2 · Bin E-04'
      },
      {
        sku: 'OIL-CASTROL-4T-1L',
        name: 'Castrol Activ 4T 20W-40 1L Engine Lubricant',
        category: 'tools',
        subcategory: 'adhesives',
        hsn: '2710',
        gst: 18.00,
        weight: 0.950,
        desc: 'Continuous protection with Actibond molecules for 4-stroke motorcycle engines',
        price: 440.00,
        mrp: 495.00,
        stock: 35,
        bin: 'Aisle 1 · Bin A-02'
      },
      {
        sku: 'BRAKE-PAD-DISC-01',
        name: 'Ceramic Front Disc Brake Pad Set (Bajaj Pulsar / Apache)',
        category: 'tools',
        subcategory: 'safety',
        hsn: '8708',
        gst: 28.00,
        weight: 0.450,
        desc: 'High friction coefficient, zero brake fade, copper-free ceramic friction formula',
        price: 380.00,
        mrp: 450.00,
        stock: 25,
        bin: 'Aisle 4 · Bin M-08'
      }
    ];

    for (const p of demoProducts) {
      const prodRes = await client.query(
        `INSERT INTO products 
         (sku, name, category, subcategory, hsn_code, gst_rate_percent, unit_weight_kg, description) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
         ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [p.sku, p.name, p.category, p.subcategory, p.hsn, p.gst, p.weight, p.desc]
      );
      const productId = prodRes.rows[0].id;

      // Seed stock in Merchant A
      await client.query(
        `INSERT INTO store_inventory 
         (merchant_id, product_id, selling_price, original_mrp, stock_count, reserved_count, low_stock_threshold, bin_location) 
         VALUES ($1, $2, $3, $4, $5, 0, 5, $6) 
         ON CONFLICT (merchant_id, product_id) DO UPDATE SET stock_count = EXCLUDED.stock_count, selling_price = EXCLUDED.selling_price`,
        [merchantId, productId, p.price, p.mrp, p.stock, p.bin]
      );

      // Seed stock in Merchant B
      await client.query(
        `INSERT INTO store_inventory 
         (merchant_id, product_id, selling_price, original_mrp, stock_count, reserved_count, low_stock_threshold, bin_location) 
         VALUES ($1, $2, $3, $4, $5, 0, 5, $6) 
         ON CONFLICT (merchant_id, product_id) DO UPDATE SET stock_count = EXCLUDED.stock_count, selling_price = EXCLUDED.selling_price`,
        [merchantBId, productId, p.price, p.mrp, 15, 'Bin B-01']
      );

      // Seed Seller Declared Tax Configuration (Bucket A: Seller's goods GST)
      const halfRate = (p.gst / 2).toFixed(2);
      await client.query(
        `INSERT INTO seller_product_tax
          (product_id, merchant_id, hsn_code, gst_rate_percent, cgst_rate_percent, sgst_rate_percent, igst_rate_percent, tax_rate_source, status, effective_from)
         VALUES 
          ($1, $2, $3, $4, $5, $6, $7, 'SELLER_DECLARED', 'ACTIVE', '2024-01-01'),
          ($1, $8, $3, $4, $5, $6, $7, 'SELLER_DECLARED', 'ACTIVE', '2024-01-01')
         ON CONFLICT (product_id, merchant_id, effective_from) DO UPDATE SET 
          gst_rate_percent = EXCLUDED.gst_rate_percent,
          cgst_rate_percent = EXCLUDED.cgst_rate_percent,
          sgst_rate_percent = EXCLUDED.sgst_rate_percent,
          igst_rate_percent = EXCLUDED.igst_rate_percent`,
        [productId, merchantId, p.hsn, p.gst, halfRate, halfRate, p.gst, merchantBId]
      );
    }

    // 12. Demo Delivery Partner A & B
    console.log('[Seeds] Seeding Demo Delivery Partners...');
    const riderAUser = await client.query(
      `INSERT INTO users (phone, name, is_phone_verified, account_type)
       VALUES ($1, $2, TRUE, 'individual')
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      ['+91-9812345678', 'Arjun Teja']
    );
    const riderBUser = await client.query(
      `INSERT INTO users (phone, name, is_phone_verified, account_type)
       VALUES ($1, $2, TRUE, 'individual')
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      ['+91-9812345679', 'Kiran Kumar']
    );

    const riderRoleId = roleMap.get('RIDER');
    if (riderRoleId) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $2) ON CONFLICT DO NOTHING`,
        [riderAUser.rows[0].id, riderRoleId, riderBUser.rows[0].id]
      );
    }

    await client.query(
      `INSERT INTO riders 
       (rider_code, name, phone, pan_number, pan_status, vehicle_type, vehicle_plate, payload_capacity_kg, rating, tier, status, latitude, longitude, kyc_status, user_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) 
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name`,
      [
        'RIDER-77',
        'Arjun Teja',
        '+91-9812345678',
        'BCDEF2345G',
        'VALID_PAN',
        'ev_scooter',
        'KA-01-EQ-9102',
        20.00,
        4.92,
        'Gold',
        'IDLE_AT_HUB',
        12.9360,
        77.6250,
        'GREEN',
        riderAUser.rows[0].id,
      ]
    );

    await client.query(
      `INSERT INTO riders 
       (rider_code, name, phone, pan_number, pan_status, vehicle_type, vehicle_plate, payload_capacity_kg, rating, tier, status, latitude, longitude, kyc_status, user_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) 
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name`,
      [
        'RIDER-88',
        'Kiran Kumar',
        '+91-9812345679',
        'CDEFG3456H',
        'VALID_PAN',
        'motorcycle',
        'KA-02-MK-5501',
        25.00,
        4.85,
        'Silver',
        'IDLE_AT_HUB',
        12.9720,
        77.6420,
        'GREEN',
        riderBUser.rows[0].id,
      ]
    );

    // 13. Demo Customer A & B
    console.log('[Seeds] Seeding Demo Customers & Saved Profiles...');
    const userRes = await client.query(
      `INSERT INTO users 
       (phone, name, email, is_phone_verified, account_type, pan_number, pan_status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      ['+91-9876543210', 'Vikram Contractor', 'vikram@sitebuilders.local', true, 'business', 'ABCDE1234F', 'VALID_PAN']
    );
    const userId = userRes.rows[0].id;

    const userBRes = await client.query(
      `INSERT INTO users 
       (phone, name, email, is_phone_verified, account_type, pan_number, pan_status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      ['+91-9876543211', 'Sunil Electricals', 'sunil@sunilelectricals.local', true, 'business', 'DEFGH5678I', 'VALID_PAN']
    );
    const userBId = userBRes.rows[0].id;

    const customerRoleId = roleMap.get('CUSTOMER');
    if (customerRoleId) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING`,
        [userId, customerRoleId, userBId, customerRoleId]
      );
    }

    await client.query(
      `INSERT INTO saved_gstins 
       (user_id, gstin, legal_business_name, trade_name, billing_address, state, state_code, pincode, is_default) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, '29AABCS1429B1Z8', 'Apex Site Builders LLP', 'Apex Indiranagar Project', 'Plot 102, 100ft Road, Indiranagar, Bengaluru', 'Karnataka', '29', '560038', true]
    );

    await client.query(
      `INSERT INTO saved_addresses 
       (user_id, address, landmark, site_contact_name, site_phone, trade_type, latitude, longitude) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, 'Tower 4 Construction Gate, Palm Heights, Koramangala', 'Opposite Sony Signal', 'Rahul Site Supervisor', '+91-9876543210', 'electrical', 12.9380, 77.6290]
    );

    // 14. Demo Admin & Super Admin Users
    console.log('[Seeds] Seeding Demo Admins...');
    const superAdminUser = await client.query(
      `INSERT INTO users (phone, name, email, is_phone_verified, account_type)
       VALUES ('+91-8000000000', 'Super Administrator', 'superadmin@qcom.local', TRUE, 'business')
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`
    );
    const superAdminRoleId = roleMap.get('SUPER_ADMIN');
    if (superAdminRoleId) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [superAdminUser.rows[0].id, superAdminRoleId]
      );
    }

    const opsAdminUser = await client.query(
      `INSERT INTO users (phone, name, email, is_phone_verified, account_type)
       VALUES ('+91-8000000002', 'Operations Lead', 'ops@qcom.local', TRUE, 'business')
       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`
    );
    const opsRoleId = roleMap.get('OPERATIONS');
    if (opsRoleId) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [opsAdminUser.rows[0].id, opsRoleId]
      );
    }

    // 15. Standard Pricing Delivery & Handling Rules
    console.log('[Seeds] Seeding Pricing Delivery & Handling Rules...');
    await client.query(
      `INSERT INTO pricing_delivery_rules
        (rule_code, name, base_distance_km, base_fee_inr, per_km_fee_inr, free_delivery_threshold_inr, handling_fee_inr, platform_fee_inr, effective_from)
       VALUES 
        ('BLR_METRO_STANDARD_2024', 'Bengaluru Metro Standard Logistics Slabs', 3.00, 35.00, 10.00, 1500.00, 5.00, 0.00, '2024-01-01')
       ON CONFLICT (rule_code) DO UPDATE SET 
        base_fee_inr = EXCLUDED.base_fee_inr, 
        per_km_fee_inr = EXCLUDED.per_km_fee_inr, 
        handling_fee_inr = EXCLUDED.handling_fee_inr`
    );

    // 16. Dynamic Database-Backed Coupons & Promotional Discounts
    console.log('[Seeds] Seeding Dynamic Coupons...');
    await client.query(
      `INSERT INTO coupons
        (code, description, discount_type, discount_value, min_order_value_inr, max_discount_inr, valid_from)
       VALUES
        ('WELCOME50', 'First order welcome flat ₹50 discount', 'FLAT_AMOUNT', 50.00, 200.00, NULL, '2024-01-01'),
        ('BUILDER10', 'Contractor trade 10% volume discount', 'PERCENTAGE', 10.00, 0.00, 100.00, '2024-01-01'),
        ('PROBUILD', 'Pro builder 15% discount for bulk trade orders', 'PERCENTAGE', 15.00, 100.00, 300.00, '2024-01-01')
       ON CONFLICT (code) DO UPDATE SET
        discount_value = EXCLUDED.discount_value,
        min_order_value_inr = EXCLUDED.min_order_value_inr,
        max_discount_inr = EXCLUDED.max_discount_inr`
    );

    await client.query('COMMIT');
    console.log('[Seeds] Database seeding completed successfully.');
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('[Seeds] Database seeding failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

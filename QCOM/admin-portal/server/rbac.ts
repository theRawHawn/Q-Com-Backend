import { AdminRole, AdminPermission, AdminRoleDefinition, AdminEmployeeUser, AdminUser } from '../src/types/admin';

export interface PermissionDetail {
  key: AdminPermission;
  name: string;
  level: 'View' | 'Create' | 'Edit' | 'Delete' | 'Approve' | 'Reject' | 'Publish' | 'Pause' | 'Export' | 'Execute' | 'Assign' | 'Reassign' | 'Suspend' | 'Reactivate';
  description: string;
}

export interface PermissionModuleGroup {
  moduleId: string;
  moduleName: string;
  description: string;
  permissions: PermissionDetail[];
}

export const MODULE_PERMISSION_GROUPS: PermissionModuleGroup[] = [
  {
    moduleId: 'dashboard',
    moduleName: 'Command Center & Operations Dashboard',
    description: 'Real-time telemetry, active order pipeline, GMV KPIs and operations overview',
    permissions: [
      { key: 'dashboard.view', name: 'View Overview Dashboard', level: 'View', description: 'Access live operations command center & real-time telemetry metrics' },
    ],
  },
  {
    moduleId: 'orders',
    moduleName: 'Orders Management',
    description: 'Order processing, cancellation, rider dispatch & fulfillment',
    permissions: [
      { key: 'orders.view', name: 'View Orders', level: 'View', description: 'View live marketplace orders & details' },
      { key: 'orders.create', name: 'Create Manual Order', level: 'Create', description: 'Create phone or offline manual orders' },
      { key: 'orders.edit', name: 'Edit Order Items', level: 'Edit', description: 'Modify items or address before packing' },
      { key: 'orders.update_status', name: 'Update Order Lifecycle Status', level: 'Edit', description: 'Update status from placed to preparing, packed, dispatched' },
      { key: 'orders.assign_rider', name: 'Assign Delivery Rider', level: 'Assign', description: 'Manually assign or re-route delivery rider' },
      { key: 'orders.cancel', name: 'Cancel Order', level: 'Suspend', description: 'Cancel active order with customer/merchant notification' },
      { key: 'orders.refund', name: 'Initiate Order Refund', level: 'Approve', description: 'Trigger refund for cancelled or missing items' },
      { key: 'orders.export', name: 'Export Order Datasets', level: 'Export', description: 'Export order records to Excel/CSV sheet' },
    ],
  },
  {
    moduleId: 'customers',
    moduleName: 'Customers & Contractors Directory',
    description: 'Contractor accounts, saved GSTINs & trade privileges',
    permissions: [
      { key: 'customers.view', name: 'View Customers Directory', level: 'View', description: 'View customer accounts & order history' },
      { key: 'customers.edit', name: 'Edit Customer Profile', level: 'Edit', description: 'Update contractor trade tier or details' },
      { key: 'customers.suspend', name: 'Suspend Customer Account', level: 'Suspend', description: 'Suspend suspicious or defaulting accounts' },
      { key: 'customers.reactivate', name: 'Reactivate Customer Account', level: 'Reactivate', description: 'Restore suspended customer accounts' },
      { key: 'customers.export', name: 'Export Customer Directory', level: 'Export', description: 'Export customer directory & LTV analytics' },
    ],
  },
  {
    moduleId: 'sellers',
    moduleName: 'Partner Stores & Sellers',
    description: 'Authorised merchant onboarding, GST verification & commission rates',
    permissions: [
      { key: 'sellers.view', name: 'View Merchant Hubs', level: 'View', description: 'View onboarded stores & KYC status' },
      { key: 'sellers.create', name: 'Onboard New Seller', level: 'Create', description: 'Register new hardware merchant store' },
      { key: 'sellers.edit', name: 'Edit Store Details', level: 'Edit', description: 'Modify store operating hours, radius & info' },
      { key: 'sellers.approve', name: 'Approve GST Store Onboarding', level: 'Approve', description: 'Approve pending merchant KYC & GSTIN' },
      { key: 'sellers.reject', name: 'Reject Merchant Application', level: 'Reject', description: 'Reject invalid merchant registration applications' },
      { key: 'sellers.suspend', name: 'Suspend Merchant Store', level: 'Suspend', description: 'Pause store receiving orders' },
      { key: 'sellers.reactivate', name: 'Reactivate Store', level: 'Reactivate', description: 'Restore suspended partner store' },
      { key: 'sellers.edit_commission', name: 'Modify Commission Rate %', level: 'Edit', description: 'Adjust platform fee percentage for seller' },
      { key: 'sellers.export', name: 'Export Merchant Sheet', level: 'Export', description: 'Export merchant list & revenue sheet' },
    ],
  },
  {
    moduleId: 'products',
    moduleName: 'Products & Catalogue',
    description: 'SKU pricing, category hierarchy, brands & stock inventory',
    permissions: [
      { key: 'products.view', name: 'View Catalogue SKUs', level: 'View', description: 'View marketplace products & stock' },
      { key: 'products.create', name: 'Add Product SKU', level: 'Create', description: 'Create new product listing with images & specs' },
      { key: 'products.edit', name: 'Edit Product Details', level: 'Edit', description: 'Update prices, description, specs & images' },
      { key: 'products.delete', name: 'Delete SKU', level: 'Delete', description: 'Remove product from catalogue' },
      { key: 'products.approve', name: 'Approve Seller Products', level: 'Approve', description: 'Approve seller uploaded catalogue products' },
      { key: 'products.disable', name: 'Disable / Delist SKU', level: 'Suspend', description: 'Temporarily hide product from customer search' },
      { key: 'products.export', name: 'Export Catalogue Dataset', level: 'Export', description: 'Export product inventory sheets' },
      { key: 'categories.view', name: 'View Categories', level: 'View', description: 'View category tree & subcategories' },
      { key: 'categories.create', name: 'Create Category', level: 'Create', description: 'Add new main or sub-category' },
      { key: 'categories.edit', name: 'Edit Category', level: 'Edit', description: 'Modify category names & banners' },
      { key: 'categories.delete', name: 'Delete Category', level: 'Delete', description: 'Remove unused category' },
      { key: 'brands.view', name: 'View Authorised Brands', level: 'View', description: 'View brand partner directory' },
      { key: 'brands.create', name: 'Create Brand Profile', level: 'Create', description: 'Add new OEM/Manufacturer brand' },
      { key: 'brands.edit', name: 'Edit Brand Profile', level: 'Edit', description: 'Update brand logo & verification' },
      { key: 'brands.delete', name: 'Delete Brand Profile', level: 'Delete', description: 'Remove brand profile' },
      { key: 'inventory.view', name: 'View Real-Time Inventory', level: 'View', description: 'View warehouse & seller stock levels' },
      { key: 'inventory.edit_stock', name: 'Update Stock Quantities', level: 'Edit', description: 'Adjust physical inventory counts' },
      { key: 'inventory.edit_price', name: 'Update Inventory Cost & Price', level: 'Edit', description: 'Adjust batch unit costs & selling prices' },
    ],
  },
  {
    moduleId: 'riders',
    moduleName: 'Riders & Fleet Management',
    description: 'Delivery partner onboarding, live tracking & duty status',
    permissions: [
      { key: 'riders.view', name: 'View Fleet Directory', level: 'View', description: 'View registered riders & status' },
      { key: 'riders.create', name: 'Onboard Delivery Partner', level: 'Create', description: 'Add new rider profile & vehicle' },
      { key: 'riders.edit', name: 'Edit Rider Profile', level: 'Edit', description: 'Update rider contact, vehicle or zone' },
      { key: 'riders.approve', name: 'Approve Rider Onboarding', level: 'Approve', description: 'Approve background verification & driving license' },
      { key: 'riders.suspend', name: 'Suspend Delivery Partner', level: 'Suspend', description: 'Suspend rider for SLA or policy violation' },
      { key: 'riders.reactivate', name: 'Reactivate Rider', level: 'Reactivate', description: 'Restore suspended delivery partner' },
      { key: 'riders.assign', name: 'Assign Rider to Zone', level: 'Assign', description: 'Bind rider to local authorised seller cluster (3-4 km)' },
      { key: 'riders.view_location', name: 'Live Rider GPS Telemetry', level: 'View', description: 'View live map location of active riders' },
      { key: 'riders.broadcast', name: 'Broadcast Dispatch Alert', level: 'Execute', description: 'Send push alert notification to riders' },
      { key: 'riders.export', name: 'Export Fleet Roster', level: 'Export', description: 'Export rider performance & earnings sheet' },
      { key: 'riders.payout', name: 'Authorize & Disburse Rider Payouts', level: 'Execute', description: 'Process daily, weekly, or on-demand rider earning payouts' },
    ],
  },
  {
    moduleId: 'delivery',
    moduleName: 'Delivery SLA & Logistics Operations',
    description: 'Hyperlocal 15-minute SLA monitoring, re-routing & exceptions',
    permissions: [
      { key: 'delivery.view', name: 'View Delivery Monitor', level: 'View', description: 'View real-time dispatch map & orders in transit' },
      { key: 'delivery.assign_rider', name: 'Assign Delivery Rider', level: 'Assign', description: 'Assign order to available rider' },
      { key: 'delivery.reassign_rider', name: 'Re-assign Order Rider', level: 'Reassign', description: 'Re-assign order if initial rider stalls' },
      { key: 'delivery.view_live_map', name: 'Live Dispatch Map', level: 'View', description: 'View live 2D telemetry map of all active orders' },
      { key: 'delivery.view_eta', name: 'Inspect Delivery SLA & ETA', level: 'View', description: 'Monitor ETA progress against target SLA' },
      { key: 'delivery.manage_exception', name: 'Handle Delivery Exceptions', level: 'Execute', description: 'Resolve stuck deliveries or customer refusal' },
      { key: 'service_areas.view', name: 'View Service Areas & Geofences', level: 'View', description: 'Inspect serviceable pin codes and delivery zones' },
      { key: 'service_areas.manage', name: 'Manage Service Zones', level: 'Edit', description: 'Update delivery radius, city statuses, and polygon geofences' },
    ],
  },
  {
    moduleId: 'payments',
    moduleName: 'Payments, Refunds & Settlements',
    description: 'Marketplace payments, escrow, refunds & merchant settlements',
    permissions: [
      { key: 'payments.view', name: 'View Payment Transactions', level: 'View', description: 'View payment gateway logs & razorpay/UPI receipts' },
      { key: 'payments.export', name: 'Export Financial Ledger', level: 'Export', description: 'Export transaction reports to Excel' },
      { key: 'payments.refund', name: 'Initiate Customer Refund', level: 'Create', description: 'Trigger refund for customer' },
      { key: 'payments.approve_refund', name: 'Approve High-Value Refunds', level: 'Approve', description: 'Authorize refunds exceeding threshold' },
      { key: 'payments.reconcile', name: 'Execute Gateway Reconciliation', level: 'Execute', description: 'Reconcile gateway settlement dumps' },
      { key: 'refunds.view', name: 'View Refund Requests', level: 'View', description: 'View pending & processed customer refunds' },
      { key: 'refunds.create', name: 'Create Refund Request', level: 'Create', description: 'Submit refund request for review' },
      { key: 'refunds.approve', name: 'Approve Refund Request', level: 'Approve', description: 'Approve refund payout to customer account' },
      { key: 'settlements.view', name: 'View Seller Settlements', level: 'View', description: 'View merchant weekly payout calculations' },
      { key: 'settlements.create', name: 'Generate Settlement Cycle', level: 'Create', description: 'Create seller payout batch' },
      { key: 'settlements.process', name: 'Process Seller Payout', level: 'Execute', description: 'Initiate bank transfer payout' },
      { key: 'settlements.approve', name: 'Approve Merchant Payout Batch', level: 'Approve', description: 'Authorize final bank disbursement' },
      { key: 'settlements.export', name: 'Export Payout Statements', level: 'Export', description: 'Export seller payout & GST tax breakdown' },
      { key: 'pricing.view', name: 'View Pricing & Economics', level: 'View', description: 'Inspect platform commission rates, surge multipliers, and delivery fees' },
      { key: 'pricing.manage', name: 'Manage Pricing Economics', level: 'Edit', description: 'Update platform fee rules, commission rates, and tax parameters' },
    ],
  },
  {
    moduleId: 'promotions',
    moduleName: 'Promotions, Coupons & Retail Media Ads',
    description: 'Discount campaigns, funded coupons & sponsored brand ads',
    permissions: [
      { key: 'promotions.view', name: 'View Promotions', level: 'View', description: 'View active coupons & funding deals' },
      { key: 'promotions.create', name: 'Create Promo Coupon', level: 'Create', description: 'Design new percentage/fixed discount code' },
      { key: 'promotions.edit', name: 'Edit Promo Coupon', level: 'Edit', description: 'Modify discount values, limits & validity' },
      { key: 'promotions.approve', name: 'Approve Co-Funded Campaign', level: 'Approve', description: 'Approve seller/brand co-funded discount shares' },
      { key: 'promotions.publish', name: 'Publish Promotion', level: 'Publish', description: 'Make coupon active for app checkout' },
      { key: 'promotions.pause', name: 'Pause Promotion', level: 'Pause', description: 'Temporarily disable promo code' },
      { key: 'promotions.delete', name: 'Delete Promotion', level: 'Delete', description: 'Remove promotion campaign' },
      { key: 'ads.view', name: 'View Sponsored Ad Campaigns', level: 'View', description: 'View retail media brand campaigns' },
      { key: 'ads.create', name: 'Create Sponsored Ad', level: 'Create', description: 'Set up sponsored product placement' },
      { key: 'ads.edit', name: 'Edit Sponsored Ad', level: 'Edit', description: 'Modify budget, CPM rate or creative' },
      { key: 'ads.approve', name: 'Approve Brand Ad Campaign', level: 'Approve', description: 'Approve brand advertiser placement' },
      { key: 'ads.publish', name: 'Publish Ad Campaign', level: 'Publish', description: 'Launch sponsored ad live on app search/home' },
      { key: 'ads.pause', name: 'Pause Ad Campaign', level: 'Pause', description: 'Pause ad impression serving' },
      { key: 'ads.delete', name: 'Delete Ad Campaign', level: 'Delete', description: 'Remove ad campaign' },
      { key: 'ads.export', name: 'Export Ad Performance Sheet', level: 'Export', description: 'Export brand ROI & ROAS report' },
      { key: 'ads.view_analytics', name: 'View Retail Media BI', level: 'View', description: 'View CTR, impressions & conversion analytics' },
      { key: 'cms.view', name: 'View CMS Content', level: 'View', description: 'View marketplace banners and promotional copy' },
      { key: 'cms.manage', name: 'Manage CMS Content', level: 'Edit', description: 'Create and update homepage banners and announcements' },
    ],
  },
  {
    moduleId: 'support',
    moduleName: 'Customer & Contractor Support Desk',
    description: 'Dispute resolution, contractor tickets & instant refunds',
    permissions: [
      { key: 'support.view', name: 'View Support Tickets', level: 'View', description: 'View customer & rider support tickets' },
      { key: 'support.create_ticket', name: 'Create Support Ticket', level: 'Create', description: 'Log manual complaint on behalf of user' },
      { key: 'support.update_ticket', name: 'Update Ticket & Respond', level: 'Edit', description: 'Add support notes & update status' },
      { key: 'support.resolve_ticket', name: 'Resolve & Close Ticket', level: 'Approve', description: 'Mark dispute resolved with customer sign-off' },
      { key: 'support.issue_refund', name: 'Issue Goodwill Credit', level: 'Approve', description: 'Issue wallet credit for order issues' },
      { key: 'support.manage', name: 'Support Operations Oversight', level: 'Execute', description: 'Manage escalation queues and support settings' },
    ],
  },
  {
    moduleId: 'reports',
    moduleName: 'Executive Reports & Business Intelligence',
    description: 'Financial GMV reports, seller economics & delivery SLA analytics',
    permissions: [
      { key: 'reports.view', name: 'View Business Analytics', level: 'View', description: 'Access executive analytics dashboard' },
      { key: 'reports.export', name: 'Export BI Sheets', level: 'Export', description: 'Export consolidated executive reports' },
      { key: 'reports.financial', name: 'Financial Revenue Reports', level: 'View', description: 'View platform commission & GMV breakdown' },
      { key: 'reports.operations', name: 'Operational SLA Analytics', level: 'View', description: 'View delivery minutes & SLA compliance %' },
      { key: 'reports.seller', name: 'Seller Performance BI', level: 'View', description: 'View store sales volume & fulfillment speed' },
      { key: 'reports.rider', name: 'Rider Productivity Analytics', level: 'View', description: 'View fleet utilization & daily payouts' },
      { key: 'reports.customer', name: 'Customer Cohorts & LTV', level: 'View', description: 'View contractor retention & re-order frequency' },
      { key: 'reports.marketing', name: 'Marketing & Ad Campaign ROI', level: 'View', description: 'View ad spend yields & campaign ROI' },
    ],
  },
  {
    moduleId: 'employees',
    moduleName: 'Employee Directory & Access Control',
    description: 'Staff account provisioning, status controls & departmental assignments',
    permissions: [
      { key: 'employees.view', name: 'View Employee Staff', level: 'View', description: 'View internal staff directory & profiles' },
      { key: 'employees.create', name: 'Add New Employee', level: 'Create', description: 'Provision new staff account' },
      { key: 'employees.edit', name: 'Edit Employee Details', level: 'Edit', description: 'Update designation, department or contact' },
      { key: 'employees.activate', name: 'Activate Employee', level: 'Reactivate', description: 'Grant active status to employee account' },
      { key: 'employees.deactivate', name: 'Deactivate Employee', level: 'Suspend', description: 'Deactivate staff account & revoke access' },
      { key: 'employees.suspend', name: 'Suspend Employee Account', level: 'Suspend', description: 'Instantly lock staff member out of Admin Panel' },
      { key: 'users.view', name: 'View Users System', level: 'View', description: 'Access user directory' },
      { key: 'users.create', name: 'Create Users', level: 'Create', description: 'Provision user accounts' },
      { key: 'users.edit', name: 'Edit Users', level: 'Edit', description: 'Modify user configurations' },
    ],
  },
  {
    moduleId: 'roles',
    moduleName: 'Dynamic Roles & Permission Matrix',
    description: 'Create custom roles, assign granular action permissions & role governance',
    permissions: [
      { key: 'roles.view', name: 'View Roles & Permission Matrix', level: 'View', description: 'Inspect all custom & system roles & permissions' },
      { key: 'roles.create', name: 'Create Custom Role', level: 'Create', description: 'Define completely new role with custom permission matrix' },
      { key: 'roles.edit', name: 'Edit Role Permissions', level: 'Edit', description: 'Modify permissions assigned to custom role' },
      { key: 'roles.deactivate', name: 'Deactivate Role', level: 'Suspend', description: 'Deactivate role (with employee re-assignment check)' },
      { key: 'roles.assign', name: 'Assign Roles to Employees', level: 'Assign', description: 'Grant or revoke roles for staff members' },
      { key: 'roles.manage', name: 'Manage System Roles', level: 'Execute', description: 'Full administrative governance over role definitions' },
      { key: 'permissions.view', name: 'View Permission Definitions', level: 'View', description: 'Inspect system action permission keys' },
      { key: 'permissions.assign', name: 'Assign User Permission Overrides', level: 'Assign', description: 'Grant explicit user-level permission overrides' },
    ],
  },
  {
    moduleId: 'audit',
    moduleName: 'Audit Trail & System Settings',
    description: 'Append-only security logs, platform settings & multi-state GST configuration',
    permissions: [
      { key: 'audit.view', name: 'View Security Audit Logs', level: 'View', description: 'Inspect system access logs & administrative actions' },
      { key: 'audit_logs.view', name: 'Inspect Detailed Audit Trail', level: 'View', description: 'Inspect full payload of administrative security logs' },
      { key: 'audit_logs.export', name: 'Export Audit Log Sheets', level: 'Export', description: 'Export security logs for compliance audit' },
      { key: 'settings.view', name: 'View System Settings', level: 'View', description: 'View platform fees, delivery surcharges & thresholds' },
      { key: 'settings.edit', name: 'Modify System Settings', level: 'Edit', description: 'Update platform parameters, commission fees & SLA targets' },
      { key: 'settings.manage', name: 'Super Admin Security Settings', level: 'Execute', description: 'Manage global security rules & MFA policies' },
    ],
  },
];

// Helper to collect ALL permissions defined in the system
export const ALL_SYSTEM_PERMISSIONS: AdminPermission[] = MODULE_PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((p) => p.key)
);

// Pre-configured dynamic initial roles
export const DEFAULT_DYNAMIC_ROLES: AdminRoleDefinition[] = [
  {
    id: 'role-super-admin',
    code: 'SUPER_ADMIN',
    name: 'Main Admin / Super Admin',
    department: 'Executive Leadership',
    description: 'Unrestricted master access across all platform modules, employee provisioning, role creation & security settings.',
    status: 'ACTIVE',
    isSystemRole: true,
    permissions: [...ALL_SYSTEM_PERMISSIONS],
    createdAt: '2025-01-01',
    updatedAt: '2026-08-25',
  },
  {
    id: 'role-ops-mgr',
    code: 'OPERATIONS_MANAGER',
    name: 'Operations Manager',
    department: 'Live Dispatch & Hub Operations',
    description: 'Oversees daily order fulfillment, merchant hubs, rider dispatch SLA, customer disputes, and operational analytics.',
    status: 'ACTIVE',
    isSystemRole: true,
    permissions: [
      'dashboard.view',
      'orders.view', 'orders.create', 'orders.edit', 'orders.cancel', 'orders.refund', 'orders.export', 'orders.assign_rider', 'orders.update_status', 'orders.edit_status',
      'sellers.view', 'sellers.suspend', 'sellers.export',
      'riders.view', 'riders.approve', 'riders.suspend', 'riders.assign', 'riders.view_location', 'riders.broadcast', 'riders.export',
      'delivery.view', 'delivery.assign_rider', 'delivery.reassign_rider', 'delivery.view_live_map', 'delivery.view_eta', 'delivery.manage_exception',
      'customers.view', 'customers.edit', 'customers.export',
      'inventory.view', 'inventory.edit_stock',
      'service_areas.view', 'service_areas.manage',
      'support.view', 'support.create_ticket', 'support.update_ticket', 'support.resolve_ticket',
      'reports.view', 'reports.export', 'reports.operations', 'reports.seller', 'reports.rider',
      'audit.view', 'audit_logs.view',
    ],
    createdAt: '2025-01-05',
    updatedAt: '2026-08-25',
  },
  {
    id: 'role-order-ops-exec',
    code: 'ORDER_OPS_EXEC',
    name: 'Order Operations Executive',
    department: 'Fulfillment & Dispatch',
    description: 'Handles daily order monitoring, status updates, rider re-assignments, and delayed order exceptions.',
    status: 'ACTIVE',
    isSystemRole: false,
    permissions: [
      'dashboard.view',
      'orders.view', 'orders.update_status', 'orders.edit_status', 'orders.cancel', 'orders.assign_rider', 'orders.export',
      'sellers.view',
      'riders.view', 'riders.view_location',
      'delivery.view', 'delivery.view_live_map', 'delivery.view_eta', 'delivery.manage_exception',
      'customers.view',
      'reports.view', 'reports.operations',
    ],
    createdAt: '2025-02-10',
    updatedAt: '2026-08-25',
  },
  {
    id: 'role-seller-mgr',
    code: 'SELLER_MANAGER',
    name: 'Seller Manager',
    department: 'Merchant Network & Partnerships',
    description: 'Manages hardware partner store onboarding, GSTIN verification, commission structures & seller catalogue approval.',
    status: 'ACTIVE',
    isSystemRole: true,
    permissions: [
      'dashboard.view',
      'sellers.view', 'sellers.create', 'sellers.edit', 'sellers.approve', 'sellers.reject', 'sellers.suspend', 'sellers.reactivate', 'sellers.edit_commission', 'sellers.export',
      'products.view', 'products.approve', 'products.disable', 'products.export',
      'inventory.view', 'inventory.edit_price',
      'orders.view',
      'reports.view', 'reports.seller',
      'audit.view',
    ],
    createdAt: '2025-01-10',
    updatedAt: '2026-08-25',
  },
  {
    id: 'role-rider-mgr',
    code: 'DELIVERY_MANAGER',
    name: 'Rider / Delivery Manager',
    department: 'Fleet & Logistics',
    description: 'Manages rider onboarding, license verification, duty status, live telemetry dispatching & fleet payouts.',
    status: 'ACTIVE',
    isSystemRole: true,
    permissions: [
      'dashboard.view',
      'riders.view', 'riders.create', 'riders.edit', 'riders.approve', 'riders.suspend', 'riders.reactivate', 'riders.assign', 'riders.view_location', 'riders.broadcast', 'riders.export', 'riders.payout',
      'delivery.view', 'delivery.assign_rider', 'delivery.reassign_rider', 'delivery.view_live_map', 'delivery.view_eta', 'delivery.manage_exception',
      'orders.view', 'orders.assign_rider',
      'service_areas.view',
      'reports.view', 'reports.rider',
      'audit.view',
    ],
    createdAt: '2025-01-12',
    updatedAt: '2026-08-25',
  },
  {
    id: 'role-support-exec',
    code: 'CUSTOMER_SUPPORT',
    name: 'Customer Support Executive',
    department: 'Contractor Care',
    description: 'Assists contractors & buyers with order tracking, complaint resolution, ticket updates & approved refunds.',
    status: 'ACTIVE',
    isSystemRole: true,
    permissions: [
      'dashboard.view',
      'customers.view', 'customers.edit',
      'orders.view', 'orders.cancel',
      'support.view', 'support.create_ticket', 'support.update_ticket', 'support.resolve_ticket', 'support.issue_refund', 'support.manage',
      'refunds.view', 'refunds.create',
      'payments.view',
    ],
    createdAt: '2025-01-15',
    updatedAt: '2026-08-25',
  },
  {
    id: 'role-finance-mgr',
    code: 'FINANCE_ADMIN',
    name: 'Finance Manager',
    department: 'Finance & Accounts',
    description: 'Manages payment gateway reconciliation, seller weekly payouts, GST tax invoicing & high-value refund approvals.',
    status: 'ACTIVE',
    isSystemRole: true,
    permissions: [
      'dashboard.view',
      'payments.view', 'payments.export', 'payments.refund', 'payments.approve_refund', 'payments.reconcile',
      'refunds.view', 'refunds.create', 'refunds.approve',
      'settlements.view', 'settlements.create', 'settlements.process', 'settlements.approve', 'settlements.export',
      'riders.payout',
      'pricing.view', 'pricing.manage',
      'orders.view',
      'sellers.view',
      'ads.approve',
      'reports.view', 'reports.export', 'reports.financial',
      'audit.view', 'audit_logs.view', 'audit_logs.export',
    ],
    createdAt: '2025-01-08',
    updatedAt: '2026-08-25',
  },
  {
    id: 'role-marketing-mgr',
    code: 'MARKETING_ADMIN',
    name: 'Marketing Manager',
    department: 'Brand Marketing & Growth',
    description: 'Creates & manages checkout promo coupons, homepage hero banners & sponsored brand advertising campaigns.',
    status: 'ACTIVE',
    isSystemRole: true,
    permissions: [
      'dashboard.view',
      'promotions.view', 'promotions.create', 'promotions.edit', 'promotions.approve', 'promotions.publish', 'promotions.pause', 'promotions.delete',
      'ads.view', 'ads.create', 'ads.edit', 'ads.approve', 'ads.publish', 'ads.pause', 'ads.delete', 'ads.export', 'ads.view_analytics',
      'cms.view', 'cms.manage',
      'reports.view', 'reports.marketing',
      'audit.view',
    ],
    createdAt: '2025-01-18',
    updatedAt: '2026-08-25',
  },
  {
    id: 'role-catalogue-mgr',
    code: 'CATALOGUE_MANAGER',
    name: 'Catalogue Manager',
    department: 'Category & Merchandising',
    description: 'Manages master hardware product catalog, brand directory, taxonomy categories & pricing specs.',
    status: 'ACTIVE',
    isSystemRole: false,
    permissions: [
      'dashboard.view',
      'products.view', 'products.create', 'products.edit', 'products.delete', 'products.approve', 'products.disable', 'products.export',
      'categories.view', 'categories.create', 'categories.edit', 'categories.delete',
      'brands.view', 'brands.create', 'brands.edit', 'brands.delete',
      'inventory.view', 'inventory.edit_stock', 'inventory.edit_price',
      'pricing.view',
    ],
    createdAt: '2025-02-01',
    updatedAt: '2026-08-25',
  },
  {
    id: 'role-analyst',
    code: 'ANALYST',
    name: 'Business Analyst',
    department: 'Business Intelligence',
    description: 'Read-only business intelligence access across GMV, delivery SLA, merchant growth, unit economics & export.',
    status: 'ACTIVE',
    isSystemRole: true,
    permissions: [
      'dashboard.view',
      'reports.view', 'reports.export', 'reports.financial', 'reports.operations', 'reports.seller', 'reports.rider', 'reports.customer', 'reports.marketing',
      'orders.view', 'orders.export',
      'sellers.view', 'sellers.export',
      'riders.view', 'riders.export',
      'customers.view', 'customers.export',
      'inventory.view',
      'payments.view', 'payments.export',
      'settlements.view', 'settlements.export',
      'promotions.view',
      'ads.view', 'ads.view_analytics', 'ads.export',
      'audit.view', 'audit_logs.view',
    ],
    createdAt: '2025-01-20',
    updatedAt: '2026-08-25',
  },
];

// Helper to calculate effective permissions for an employee dynamically
export function calculateEmployeePermissions(
  employee: AdminEmployeeUser,
  allRoles: AdminRoleDefinition[]
): AdminPermission[] {
  // If employee is NOT ACTIVE (i.e., INACTIVE or SUSPENDED), deny ALL permissions instantly!
  if (employee.status !== 'ACTIVE') {
    return [];
  }

  // Find all assigned roles
  const assignedRoles = allRoles.filter(
    (r) =>
      r.status === 'ACTIVE' &&
      (employee.assignedRoleIds?.includes(r.id) || employee.assignedRoleIds?.includes(r.code) || employee.role === r.code)
  );

  // Check if user has Super Admin role
  const isSuperAdmin = assignedRoles.some((r) => r.code === 'SUPER_ADMIN') || employee.role === 'SUPER_ADMIN';
  if (isSuperAdmin) {
    return [...ALL_SYSTEM_PERMISSIONS];
  }

  // Combine permissions from all active assigned roles
  const permSet = new Set<AdminPermission>();
  assignedRoles.forEach((role) => {
    role.permissions.forEach((p) => permSet.add(p));
  });

  // Apply user-level custom overrides if present
  if (employee.customPermissionsOverride) {
    employee.customPermissionsOverride.forEach((p) => permSet.add(p));
  }

  return Array.from(permSet);
}

// Deprecated static lookup fallback
export function hasPermission(role: AdminRole, permission: AdminPermission): boolean {
  const roleDef = DEFAULT_DYNAMIC_ROLES.find((r) => r.code === role);
  if (!roleDef) return false;
  if (roleDef.code === 'SUPER_ADMIN') return true;
  return roleDef.permissions.includes(permission);
}

export const PRESET_ADMIN_USERS: AdminUser[] = [
  {
    id: 'emp-001',
    name: 'Vikramaditya Rao',
    email: 'vikram.rao@qcom.trade',
    role: 'SUPER_ADMIN',
    roleTitle: 'Chief Technology & Operations Officer',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80',
    department: 'Executive Management',
    lastLogin: 'Today, 08:30 AM',
    status: 'ACTIVE',
  },
  {
    id: 'emp-002',
    name: 'Pooja Narang',
    email: 'pooja.n@qcom.trade',
    role: 'OPERATIONS_MANAGER',
    roleTitle: 'Senior Operations Lead (Bengaluru)',
    avatar: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=120&auto=format&fit=crop&q=80',
    department: 'Live Dispatch Operations',
    lastLogin: 'Today, 09:12 AM',
    status: 'ACTIVE',
  },
];

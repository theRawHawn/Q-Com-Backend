import React, { useState, useEffect } from 'react';
import { AdminHeader } from './components/admin/AdminHeader';
import { AdminSidebar } from './components/admin/AdminSidebar';
import { PermissionDeniedBanner } from './components/admin/PermissionDeniedBanner';
import { DashboardOverview } from './components/admin/DashboardOverview';
import { OrderControlCenter } from './components/admin/OrderControlCenter';
import { DispatchOperations } from './components/admin/DispatchOperations';
import { SellerManagement } from './components/admin/SellerManagement';
import { RiderFleetManagement } from './components/admin/RiderFleetManagement';
import { CustomerManagement } from './components/admin/CustomerManagement';
import { InventoryManagement } from './components/admin/InventoryManagement';
import { PaymentsAndRefunds } from './components/admin/PaymentsAndRefunds';
import { SellerSettlements } from './components/admin/SellerSettlements';
import { ServiceAreasConfig } from './components/admin/ServiceAreasConfig';
import { SupportDesk } from './components/admin/SupportDesk';
import { AuditLogsViewer } from './components/admin/AuditLogsViewer';
import { MarketplaceSettings } from './components/admin/MarketplaceSettings';
import { PromotionsManager } from './components/admin/PromotionsManager';
import { SponsoredAdsManager } from './components/admin/SponsoredAdsManager';
import { CmsContentManager } from './components/admin/CmsContentManager';
import { EmployeeRoleManager } from './components/admin/EmployeeRoleManager';
import { ReportsAnalytics } from './components/admin/ReportsAnalytics';

import { AdminUser, AdminRole, AdminPermission, IndianCityConfig } from './types/admin';
import { adminApi } from './utils/adminApiClient';

// 7 Pre-configured RBAC Admin Personas for live testing & inspection
const AVAILABLE_ADMIN_PERSONAS: AdminUser[] = [
  {
    id: 'emp-001',
    name: 'Vikramaditya Rao',
    email: 'vikram.rao@qcom.trade',
    role: 'SUPER_ADMIN',
    roleTitle: 'Main Admin / Super Admin',
    department: 'Executive Leadership',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&auto=format&fit=crop&q=80',
    lastLogin: 'Just now',
  },
  {
    id: 'emp-002',
    name: 'Pooja Narang',
    email: 'pooja.n@qcom.trade',
    role: 'OPERATIONS_ADMIN',
    roleTitle: 'Head of National Hub Operations',
    department: 'Fulfillment & Dispatch',
    avatar: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=120&auto=format&fit=crop&q=80',
    lastLogin: '5 mins ago',
  },
  {
    id: 'emp-003',
    name: 'Anand Sundaram',
    email: 'anand.s@qcom.trade',
    role: 'SELLER_MANAGER',
    roleTitle: 'Authorised Merchant Onboarding Lead',
    department: 'Supply Partnerships',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&auto=format&fit=crop&q=80',
    lastLogin: '18 mins ago',
  },
  {
    id: 'emp-004',
    name: 'Kavita Hegde',
    email: 'kavita.h@qcom.trade',
    role: 'DELIVERY_MANAGER',
    roleTitle: 'Pan-India Fleet Telemetry Controller',
    department: 'Logistics',
    avatar: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=120&auto=format&fit=crop&q=80',
    lastLogin: '1 hour ago',
  },
  {
    id: 'emp-005',
    name: 'Deepak Mehrotra',
    email: 'deepak.m@qcom.trade',
    role: 'FINANCE_ADMIN',
    roleTitle: 'Reconciliation & Multi-State GST Comptroller',
    department: 'Finance & Accounts',
    avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=120&auto=format&fit=crop&q=80',
    lastLogin: '2 hours ago',
  },
  {
    id: 'emp-008',
    name: 'Siddharth Varma',
    email: 'siddharth.v@qcom.trade',
    role: 'MARKETING_ADMIN',
    roleTitle: 'Retail Media & Brand Promotions Lead',
    department: 'Marketing & Brand Monetization',
    avatar: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=120&auto=format&fit=crop&q=80',
    lastLogin: '10 mins ago',
  },
  {
    id: 'emp-006',
    name: 'Nisha Pillai',
    email: 'nisha.p@qcom.trade',
    role: 'CUSTOMER_SUPPORT',
    roleTitle: 'Senior Contractor Support Specialist',
    department: 'Customer Care',
    avatar: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=120&auto=format&fit=crop&q=80',
    lastLogin: '32 mins ago',
  },
];

// Required permission for each active view tab
const TAB_PERMISSION_MAP: Record<string, AdminPermission> = {
  dashboard: 'dashboard.view',
  orders: 'orders.view',
  dispatch: 'orders.assign_rider',
  support: 'support.view',
  sellers: 'sellers.view',
  riders: 'riders.view',
  customers: 'customers.view',
  inventory: 'inventory.view',
  payments: 'payments.view',
  refunds: 'refunds.view',
  settlements: 'settlements.view',
  pricing: 'pricing.view',
  promotions: 'promotions.view',
  ads: 'ads.view',
  cms: 'cms.view',
  employees: 'users.view',
  reports: 'reports.view',
  service_areas: 'service_areas.view',
  audit: 'audit.view',
  settings: 'settings.manage',
};

// Default permission mapping for offline/instant hydration
const DEFAULT_ROLE_PERMISSIONS: Record<AdminRole, AdminPermission[]> = {
  SUPER_ADMIN: [
    'dashboard.view', 'orders.view', 'orders.edit_status', 'orders.cancel', 'orders.assign_rider',
    'sellers.view', 'sellers.approve', 'sellers.suspend', 'sellers.edit_commission',
    'riders.view', 'riders.approve', 'riders.suspend', 'riders.broadcast',
    'customers.view', 'customers.edit_status', 'customers.view_sensitive',
    'inventory.view', 'inventory.edit_stock', 'inventory.edit_price',
    'payments.view', 'payments.reconcile', 'refunds.view', 'refunds.create', 'refunds.approve',
    'settlements.view', 'settlements.process', 'pricing.view', 'pricing.manage',
    'promotions.view', 'promotions.create', 'promotions.approve',
    'ads.view', 'ads.create', 'ads.publish', 'ads.approve',
    'cms.view', 'cms.manage', 'reports.view',
    'users.view', 'users.create', 'users.edit',
    'service_areas.view', 'service_areas.manage', 'audit.view', 'support.view', 'support.manage', 'settings.manage'
  ],
  OPERATIONS_ADMIN: [
    'dashboard.view', 'orders.view', 'orders.edit_status', 'orders.cancel', 'orders.assign_rider',
    'sellers.view', 'sellers.suspend', 'riders.view', 'riders.approve', 'riders.suspend', 'riders.broadcast',
    'customers.view', 'inventory.view', 'inventory.edit_stock', 'service_areas.view', 'service_areas.manage',
    'support.view', 'support.manage', 'audit.view', 'reports.view'
  ],
  SELLER_MANAGER: [
    'dashboard.view', 'sellers.view', 'sellers.approve', 'sellers.suspend', 'sellers.edit_commission',
    'inventory.view', 'inventory.edit_price', 'pricing.view', 'orders.view', 'audit.view'
  ],
  DELIVERY_MANAGER: [
    'dashboard.view', 'riders.view', 'riders.approve', 'riders.suspend', 'riders.broadcast',
    'orders.view', 'orders.assign_rider', 'service_areas.view', 'audit.view'
  ],
  FINANCE_ADMIN: [
    'dashboard.view', 'orders.view', 'sellers.view', 'payments.view', 'payments.reconcile',
    'refunds.view', 'refunds.create', 'refunds.approve', 'settlements.view', 'settlements.process',
    'pricing.view', 'pricing.manage', 'audit.view', 'reports.view', 'promotions.view'
  ],
  MARKETING_ADMIN: [
    'dashboard.view', 'promotions.view', 'promotions.create', 'promotions.approve',
    'ads.view', 'ads.create', 'ads.publish', 'ads.approve',
    'cms.view', 'cms.manage', 'reports.view', 'sellers.view', 'inventory.view'
  ],
  CUSTOMER_SUPPORT: [
    'dashboard.view', 'customers.view', 'customers.edit_status', 'orders.view', 'orders.cancel',
    'refunds.view', 'refunds.create', 'support.view', 'support.manage'
  ],
  ANALYST: [
    'dashboard.view', 'orders.view', 'sellers.view', 'riders.view', 'customers.view',
    'inventory.view', 'payments.view', 'refunds.view', 'settlements.view',
    'service_areas.view', 'pricing.view', 'audit.view', 'reports.view', 'promotions.view', 'ads.view', 'cms.view'
  ],
};

// Helper to determine initial tab from URL hash or localStorage
const getInitialActiveTab = (): string => {
  try {
    const hash = window.location.hash.replace(/^#/, '').trim();
    if (hash && TAB_PERMISSION_MAP[hash]) {
      return hash;
    }
    const saved = localStorage.getItem('qcom_admin_active_tab');
    if (saved && TAB_PERMISSION_MAP[saved]) {
      return saved;
    }
  } catch {
    // fallback
  }
  return 'dashboard';
};

export default function App() {
  const [currentUser, setCurrentUser] = useState<AdminUser>(AVAILABLE_ADMIN_PERSONAS[0]);
  const [userPermissions, setUserPermissions] = useState<AdminPermission[]>(
    DEFAULT_ROLE_PERMISSIONS[AVAILABLE_ADMIN_PERSONAS[0].role] || []
  );
  const [activeTab, setActiveTabState] = useState<string>(getInitialActiveTab);
  const [activeAlertsCount, setActiveAlertsCount] = useState<number>(7);
  const [cities, setCities] = useState<IndianCityConfig[]>([]);
  const [selectedCity, setSelectedCity] = useState<string>('all');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState<boolean>(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState<string>('');

  // Synchronize activeTab with URL hash & localStorage
  const setActiveTab = (newTab: string) => {
    setActiveTabState(newTab);
    try {
      localStorage.setItem('qcom_admin_active_tab', newTab);
      if (window.location.hash !== `#${newTab}`) {
        window.history.replaceState(null, '', `#${newTab}`);
      }
    } catch {
      // ignore in restricted environments
    }
  };

  // Listen for browser Back/Forward / hash changes
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace(/^#/, '').trim();
      if (hash && TAB_PERMISSION_MAP[hash]) {
        setActiveTabState(hash);
        try {
          localStorage.setItem('qcom_admin_active_tab', hash);
        } catch {}
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Sync API client session role when user switches persona
  useEffect(() => {
    adminApi.setAdminRole(currentUser.role);
    adminApi.setAdminId(currentUser.id);
    
    // Set immediate permissions from matrix
    if (DEFAULT_ROLE_PERMISSIONS[currentUser.role]) {
      setUserPermissions(DEFAULT_ROLE_PERMISSIONS[currentUser.role]);
    }

    // Fetch dynamic permissions for this role from server authoritative matrix
    const fetchPerms = async () => {
      try {
        const res: any = await adminApi.get('/api/admin/me');
        if (res.success && res.permissions) {
          setUserPermissions(res.permissions);
        } else if (res.success && res.user?.permissions) {
          setUserPermissions(res.user.permissions);
        }
      } catch (err) {
        console.warn('Using client permissions fallback:', err);
      }
    };
    fetchPerms();
  }, [currentUser]);

  // Load operational Indian cities list
  useEffect(() => {
    const fetchCities = async () => {
      try {
        const res: any = await adminApi.get('/api/admin/cities');
        if (res.success) {
          setCities(res.cities);
        }
      } catch (err) {
        console.error('Failed to load Indian cities:', err);
      }
    };
    fetchCities();
  }, []);

  const handleGlobalSearch = (query: string) => {
    setGlobalSearchQuery(query);
  };

  const currentTabRequiredPermission = TAB_PERMISSION_MAP[activeTab];
  const isSuperAdmin = currentUser.role === 'SUPER_ADMIN' || userPermissions.includes('*' as any) || userPermissions.length > 25;
  const isPermitted =
    isSuperAdmin ||
    !currentTabRequiredPermission ||
    userPermissions.includes(currentTabRequiredPermission) ||
    (currentTabRequiredPermission === 'users.view' && (userPermissions.includes('employees.view') || userPermissions.includes('roles.view'))) ||
    (currentTabRequiredPermission === 'settings.manage' && userPermissions.includes('settings.view'));

  const renderActiveView = () => {
    if (!isPermitted) {
      return (
        <PermissionDeniedBanner
          requiredPermission={currentTabRequiredPermission}
          currentRole={currentUser.role}
          roleTitle={currentUser.roleTitle || currentUser.role}
          onSwitchToSuperAdmin={() => {
            const superAdmin = AVAILABLE_ADMIN_PERSONAS.find((p) => p.role === 'SUPER_ADMIN') || AVAILABLE_ADMIN_PERSONAS[0];
            setCurrentUser(superAdmin);
            adminApi.setPersona(superAdmin);
          }}
        />
      );
    }

    switch (activeTab) {
      case 'dashboard':
        return <DashboardOverview onNavigateTab={setActiveTab} selectedCity={selectedCity} />;
      case 'orders':
        return (
          <OrderControlCenter
            userPermissions={userPermissions}
            selectedCity={selectedCity}
            searchQuery={globalSearchQuery}
            onSearchQueryChange={setGlobalSearchQuery}
          />
        );
      case 'dispatch':
        return (
          <DispatchOperations
            userPermissions={userPermissions}
            searchQuery={globalSearchQuery}
            onSearchQueryChange={setGlobalSearchQuery}
          />
        );
      case 'support':
        return <SupportDesk userPermissions={userPermissions} />;
      case 'sellers':
        return (
          <SellerManagement
            userPermissions={userPermissions}
            selectedCity={selectedCity}
            searchQuery={globalSearchQuery}
            onSearchQueryChange={setGlobalSearchQuery}
          />
        );
      case 'riders':
        return (
          <RiderFleetManagement
            userPermissions={userPermissions}
            selectedCity={selectedCity}
            searchQuery={globalSearchQuery}
            onSearchQueryChange={setGlobalSearchQuery}
          />
        );
      case 'customers':
        return (
          <CustomerManagement
            userPermissions={userPermissions}
            searchQuery={globalSearchQuery}
            onSearchQueryChange={setGlobalSearchQuery}
          />
        );
      case 'inventory':
        return (
          <InventoryManagement
            userPermissions={userPermissions}
            selectedCity={selectedCity}
            searchQuery={globalSearchQuery}
            onSearchQueryChange={setGlobalSearchQuery}
          />
        );
      case 'payments':
      case 'refunds':
        return (
          <PaymentsAndRefunds
            userPermissions={userPermissions}
            selectedCity={selectedCity}
            searchQuery={globalSearchQuery}
            onSearchQueryChange={setGlobalSearchQuery}
          />
        );
      case 'settlements':
        return (
          <SellerSettlements
            userPermissions={userPermissions}
            searchQuery={globalSearchQuery}
            onSearchQueryChange={setGlobalSearchQuery}
          />
        );
      case 'promotions':
        return <PromotionsManager />;
      case 'ads':
        return <SponsoredAdsManager />;
      case 'cms':
        return <CmsContentManager />;
      case 'employees':
        return <EmployeeRoleManager />;
      case 'reports':
        return <ReportsAnalytics selectedCity={selectedCity} onNavigateTab={setActiveTab} />;
      case 'service_areas':
        return (
          <ServiceAreasConfig 
            userPermissions={userPermissions} 
            selectedCity={selectedCity}
            onSelectCity={setSelectedCity}
            searchQuery={globalSearchQuery}
            onSearchQueryChange={setGlobalSearchQuery}
          />
        );
      case 'audit':
        return <AuditLogsViewer userPermissions={userPermissions} />;
      case 'settings':
        return <MarketplaceSettings userPermissions={userPermissions} />;
      default:
        return <DashboardOverview onNavigateTab={setActiveTab} selectedCity={selectedCity} />;
    }
  };

  return (
    <div className="h-screen h-[100dvh] w-full bg-[#f8fafc] text-slate-900 flex flex-col font-sans selection:bg-[#009DE0] selection:text-white antialiased overflow-hidden">
      {/* Top Fixed Admin Header */}
      <AdminHeader
        currentUser={currentUser}
        availableUsers={AVAILABLE_ADMIN_PERSONAS}
        onSwitchUser={setCurrentUser}
        onSearch={handleGlobalSearch}
        searchQuery={globalSearchQuery}
        activeTab={activeTab}
        activeAlertsCount={activeAlertsCount}
        onNavigateToTab={setActiveTab}
        selectedCity={selectedCity}
        onSelectCity={setSelectedCity}
        cities={cities}
        onToggleMobileSidebar={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
      />

      {/* Main Workspace: Sidebar + Dynamic Sub-system View */}
      <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden w-full">
        <AdminSidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          userPermissions={userPermissions}
          userRole={currentUser.role}
          isMobileOpen={isMobileSidebarOpen}
          onCloseMobile={() => setIsMobileSidebarOpen(false)}
        />

        <main className="flex-1 min-w-0 min-h-0 overflow-y-auto bg-[#f8fafc] focus:outline-none h-full">
          {renderActiveView()}
        </main>
      </div>
    </div>
  );
}

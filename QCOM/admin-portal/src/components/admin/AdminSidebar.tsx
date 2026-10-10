import React from 'react';
import {
  LayoutDashboard,
  ShoppingBag,
  Send,
  Store,
  Bike,
  Users,
  Package,
  CreditCard,
  RotateCcw,
  Receipt,
  MapPin,
  LifeBuoy,
  FileText,
  Settings,
  X,
  Megaphone,
  Layout,
  BarChart3,
  Shield,
  Percent
} from 'lucide-react';
import { AdminPermission, AdminRole } from '../../types/admin';

interface SidebarItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  requiredPermission: AdminPermission;
  group: 'Operations' | 'Marketing & Ads' | 'Supply & Fleet' | 'Finance' | 'Settings';
}

const SIDEBAR_ITEMS: SidebarItem[] = [
  // 1. Operations
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, requiredPermission: 'dashboard.view', group: 'Operations' },
  { id: 'orders', label: 'Orders', icon: ShoppingBag, requiredPermission: 'orders.view', group: 'Operations' },
  { id: 'dispatch', label: 'Live Dispatch', icon: Send, requiredPermission: 'orders.assign_rider', group: 'Operations' },
  { id: 'support', label: 'Support Desk', icon: LifeBuoy, requiredPermission: 'support.view', group: 'Operations' },
  { id: 'reports', label: 'Executive Reports', icon: BarChart3, requiredPermission: 'reports.view', group: 'Operations' },

  // 2. Marketing & Retail Media
  { id: 'promotions', label: 'Promotions & Coupons', icon: Percent, requiredPermission: 'promotions.view', group: 'Marketing & Ads' },
  { id: 'ads', label: 'Sponsored Ads Engine', icon: Megaphone, requiredPermission: 'ads.view', group: 'Marketing & Ads' },
  { id: 'cms', label: 'Content & CMS', icon: Layout, requiredPermission: 'cms.view', group: 'Marketing & Ads' },

  // 3. Supply & Fleet
  { id: 'sellers', label: 'Partner Stores', icon: Store, requiredPermission: 'sellers.view', group: 'Supply & Fleet' },
  { id: 'riders', label: 'Riders & Fleet', icon: Bike, requiredPermission: 'riders.view', group: 'Supply & Fleet' },
  { id: 'customers', label: 'Customers', icon: Users, requiredPermission: 'customers.view', group: 'Supply & Fleet' },
  { id: 'inventory', label: 'Master Catalog', icon: Package, requiredPermission: 'inventory.view', group: 'Supply & Fleet' },

  // 4. Finance & Growth
  { id: 'refunds', label: 'Refunds Desk', icon: RotateCcw, requiredPermission: 'refunds.view', group: 'Finance' },
  { id: 'settlements', label: 'Store Settlements', icon: Receipt, requiredPermission: 'settlements.view', group: 'Finance' },

  // 5. Governance & Settings
  { id: 'employees', label: 'Employees & Roles', icon: Shield, requiredPermission: 'users.view', group: 'Settings' },
  { id: 'service_areas', label: 'Service Zones', icon: MapPin, requiredPermission: 'service_areas.view', group: 'Settings' },
  { id: 'audit', label: 'Audit Logs', icon: FileText, requiredPermission: 'audit.view', group: 'Settings' },
  { id: 'settings', label: 'Settings', icon: Settings, requiredPermission: 'settings.manage', group: 'Settings' },
];

interface AdminSidebarProps {
  activeTab: string;
  onSelectTab: (tabId: string) => void;
  userPermissions: AdminPermission[];
  userRole: AdminRole;
  isMobileOpen?: boolean;
  onCloseMobile?: () => void;
}

export const AdminSidebar: React.FC<AdminSidebarProps> = ({
  activeTab,
  onSelectTab,
  userPermissions,
  userRole,
  isMobileOpen = false,
  onCloseMobile,
}) => {
  const groups: SidebarItem['group'][] = ['Operations', 'Marketing & Ads', 'Supply & Fleet', 'Finance', 'Settings'];

  const renderSidebarContent = () => (
    <>
      {/* Navigation Groups */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3.5 space-y-5">
        {groups.map((grp) => {
          const isSuperAdmin = userRole === 'SUPER_ADMIN' || userPermissions.includes('*' as any);
          const itemsInGroup = SIDEBAR_ITEMS.filter((item) => {
            if (item.group !== grp) return false;
            if (isSuperAdmin) return true;
            return userPermissions.includes(item.requiredPermission);
          });

          if (itemsInGroup.length === 0) return null;

          return (
            <div key={grp} className="space-y-0.5">
              <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 select-none">
                {grp}
              </div>
              {itemsInGroup.map((item) => {
                const isActive = activeTab === item.id;
                const Icon = item.icon;

                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      onSelectTab(item.id);
                      if (onCloseMobile) onCloseMobile();
                    }}
                    className={`relative w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs transition-all text-left group ${
                      isActive
                        ? 'bg-sky-50/80 text-slate-950 font-semibold before:absolute before:left-0 before:top-1 before:bottom-1 before:w-[3px] before:bg-[#009DE0] before:rounded-r'
                        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 font-medium'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Icon
                        className={`h-4 w-4 shrink-0 transition-colors ${
                          isActive ? 'text-[#009DE0]' : 'text-slate-400 group-hover:text-slate-600'
                        }`}
                      />
                      <span className="truncate">{item.label}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Role Pill Footer */}
      <div className="p-3 px-3.5 border-t border-slate-200/80 bg-slate-50/50 flex items-center justify-between text-[11px] text-slate-500 select-none shrink-0">
        <div className="flex items-center gap-2 truncate">
          <span className="h-1.5 w-1.5 rounded-full bg-[#009DE0] shrink-0 shadow-[0_0_6px_rgba(0,157,224,0.6)]"></span>
          <span className="truncate font-medium text-slate-700">{userRole.replace(/_/g, ' ')}</span>
        </div>
        <span className="text-[10px] font-mono text-slate-400 uppercase">RBAC</span>
      </div>
    </>
  );

  return (
    <>
      {/* Desktop Persistent Sidebar */}
      <aside className="hidden md:flex w-56 bg-white border-r border-slate-200/80 text-slate-700 flex-col shrink-0 h-full overflow-hidden select-none">
        {renderSidebarContent()}
      </aside>

      {/* Mobile Drawer Overlay */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity"
            onClick={onCloseMobile}
          />

          {/* Drawer Panel */}
          <aside className="relative w-64 max-w-[80vw] bg-white flex flex-col h-full shadow-xl z-10 animate-in slide-in-from-left duration-200">
            <div className="p-3.5 border-b border-slate-200/80 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="h-7 w-7 rounded-md bg-[#009DE0] flex items-center justify-center font-bold text-white text-xs shadow-[0_2px_8px_rgba(0,157,224,0.35)]">
                  QC
                </div>
                <span className="font-bold text-slate-900 text-sm">Navigation</span>
              </div>
              <button
                onClick={onCloseMobile}
                className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {renderSidebarContent()}
          </aside>
        </div>
      )}
    </>
  );
};

import React, { useState, useEffect, useRef } from 'react';
import { 
  ShieldCheck, 
  Search, 
  Bell, 
  ChevronDown, 
  Clock, 
  AlertTriangle, 
  Globe2, 
  MapPin, 
  Building2, 
  Check,
  X,
  Menu
} from 'lucide-react';
import { AdminUser, IndianCityConfig } from '../../types/admin';

interface AdminHeaderProps {
  currentUser: AdminUser;
  availableUsers: AdminUser[];
  onSwitchUser: (user: AdminUser) => void;
  onSearch: (query: string) => void;
  searchQuery?: string;
  activeTab?: string;
  activeAlertsCount: number;
  onNavigateToTab: (tab: string) => void;
  selectedCity: string;
  onSelectCity: (cityId: string) => void;
  cities: IndianCityConfig[];
  onToggleMobileSidebar?: () => void;
}

export const AdminHeader: React.FC<AdminHeaderProps> = ({
  currentUser,
  availableUsers,
  onSwitchUser,
  onSearch,
  searchQuery = '',
  activeTab = 'dashboard',
  activeAlertsCount,
  onNavigateToTab,
  selectedCity,
  onSelectCity,
  cities,
  onToggleMobileSidebar,
}) => {
  const [isUserDropdownOpen, setIsUserDropdownOpen] = useState(false);
  const [isCityDropdownOpen, setIsCityDropdownOpen] = useState(false);
  const [isAlertDropdownOpen, setIsAlertDropdownOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState('');
  const [searchVal, setSearchVal] = useState(searchQuery);

  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSearchVal(searchQuery);
  }, [searchQuery, activeTab]);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentTime(
        now.toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        })
      );
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setIsUserDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(searchVal);
  };

  const getSearchPlaceholder = (tab?: string) => {
    switch (tab) {
      case 'sellers':
        return 'Search partner stores by name, GSTIN, owner, hub...';
      case 'orders':
        return 'Search orders by ID, customer, phone, store...';
      case 'riders':
        return 'Search delivery partners by name, phone, vehicle #...';
      case 'customers':
        return 'Search customers by name, phone, email, firm...';
      case 'inventory':
        return 'Search SKUs by name, brand, HSN code...';
      case 'refunds':
        return 'Search refunds by order, customer, phone, or UTR...';
      case 'settlements':
        return 'Search store settlements by seller or UTR...';
      case 'dispatch':
        return 'Search unassigned orders & fleet roster...';
      case 'promotions':
        return 'Search promo codes & campaigns...';
      case 'ads':
        return 'Search sponsored ad campaigns...';
      case 'cms':
        return 'Search CMS content & banners...';
      case 'employees':
        return 'Search staff members & roles...';
      case 'support':
        return 'Search support desk tickets...';
      case 'audit':
        return 'Search audit logs...';
      case 'service_areas':
        return 'Search hubs & service zones...';
      default:
        return 'Search current module...';
    }
  };

  const activeCityObj = cities.find((c) => c.id === selectedCity);

  return (
    <header className="bg-white border-b border-slate-200/80 text-slate-900 px-4 sm:px-6 h-14 sticky top-0 z-40 flex items-center justify-between shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
      {/* Brand & Market Scope */}
      <div className="flex items-center gap-3">
        {onToggleMobileSidebar && (
          <button
            onClick={onToggleMobileSidebar}
            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md md:hidden transition-colors"
            title="Open Navigation"
          >
            <Menu className="h-4.5 w-4.5" />
          </button>
        )}

        <div 
          onClick={() => onNavigateToTab?.('dashboard')} 
          className="flex items-center gap-2.5 cursor-pointer group select-none"
          title="Go to Dashboard"
        >
          <div className="h-7 w-7 rounded-md bg-[#009DE0] flex items-center justify-center font-bold text-white text-xs tracking-wider shadow-[0_2px_8px_rgba(0,157,224,0.35)] transition-transform group-hover:scale-[1.02]">
            QC
          </div>
          <div className="hidden xs:flex items-center gap-2">
            <span className="font-bold tracking-tight text-slate-900 text-sm">QuickBuild</span>
            <span className="text-[10px] font-semibold text-[#00608a] bg-sky-50 border border-sky-200/70 px-1.5 py-0.5 rounded tracking-normal">
              Admin
            </span>
          </div>
        </div>

        {/* Territory Selector - High precision, subtle control */}
        <div className="relative ml-2">
          <button
            onClick={() => setIsCityDropdownOpen(!isCityDropdownOpen)}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 border border-slate-200/90 hover:border-slate-300 px-2.5 py-1.5 rounded-md transition-all text-xs font-medium text-slate-700 shadow-[0_1px_2px_rgba(0,0,0,0.02)] active:bg-slate-100"
          >
            <MapPin className="h-3.5 w-3.5 text-[#009DE0] shrink-0" />
            <span className="max-w-[130px] truncate text-slate-800 font-medium">
              {selectedCity === 'all' ? 'All Hubs (National)' : activeCityObj?.name || selectedCity}
            </span>
            <ChevronDown className={`h-3 w-3 text-slate-400 transition-transform duration-150 ${isCityDropdownOpen ? 'rotate-180 text-slate-600' : ''}`} />
          </button>

          {isCityDropdownOpen && (
            <div className="absolute left-0 mt-1.5 w-64 bg-white border border-slate-200 rounded-lg shadow-[0_8px_30px_rgb(0,0,0,0.08)] z-50 p-1.5 animate-in fade-in duration-100">
              <div className="px-2.5 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                Select City Hub
              </div>
              <div className="py-0.5 max-h-60 overflow-y-auto space-y-0.5">
                <button
                  onClick={() => {
                    onSelectCity('all');
                    setIsCityDropdownOpen(false);
                  }}
                  className={`w-full text-left px-2.5 py-1.5 rounded-md flex items-center justify-between text-xs transition-colors ${
                    selectedCity === 'all' 
                      ? 'bg-sky-50 text-[#00608a] font-semibold' 
                      : 'hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <Globe2 className="h-3.5 w-3.5 text-[#009DE0]" />
                    All India (National)
                  </span>
                  {selectedCity === 'all' && <Check className="h-3.5 w-3.5 text-[#009DE0]" />}
                </button>

                {cities.map((city) => {
                  const isSelected = city.id === selectedCity;
                  return (
                    <button
                      key={city.id}
                      onClick={() => {
                        onSelectCity(city.id);
                        setIsCityDropdownOpen(false);
                      }}
                      className={`w-full text-left px-2.5 py-1.5 rounded-md flex items-center justify-between text-xs transition-colors ${
                        isSelected 
                          ? 'bg-sky-50 text-[#00608a] font-semibold' 
                          : 'hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Building2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                        <span className="truncate">{city.name}</span>
                      </div>
                      {isSelected && <Check className="h-3.5 w-3.5 text-[#009DE0]" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Global Quick Search Bar - Linear / Stripe input aesthetic */}
      <form onSubmit={handleSearchSubmit} className="flex-1 max-w-md mx-6 hidden md:block">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
          <input
            type="text"
            placeholder={getSearchPlaceholder(activeTab)}
            value={searchVal}
            onChange={(e) => {
              setSearchVal(e.target.value);
              onSearch(e.target.value);
            }}
            className="w-full bg-slate-50/80 border border-slate-200/90 rounded-md pl-9 pr-14 py-1.5 text-xs text-slate-900 placeholder-slate-400/90 focus:outline-none focus:ring-2 focus:ring-[#009DE0]/15 focus:border-[#009DE0] focus:bg-white transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
          />
          {searchVal && (
            <button
              type="button"
              onClick={() => {
                setSearchVal('');
                onSearch('');
              }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-0.5 cursor-pointer"
              title="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </form>

      {/* Right Controls */}
      <div className="flex items-center gap-2.5 sm:gap-3.5">
        {/* Live Clock */}
        <div className="hidden lg:flex items-center gap-1.5 text-slate-500 text-xs font-mono tabular-nums select-none">
          <Clock className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          <span>{currentTime || '08:45 AM'}</span>
        </div>

        <div className="hidden lg:block h-3.5 w-px bg-slate-200/80" />

        {/* Alerts Bell - Quieter, refined indicator */}
        <div className="relative">
          <button
            onClick={() => setIsAlertDropdownOpen(!isAlertDropdownOpen)}
            className="relative p-1.5 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 transition-colors cursor-pointer"
            title={`Alerts (${activeAlertsCount})`}
          >
            <Bell className="h-4 w-4" />
            {activeAlertsCount > 0 && (
              <span className="absolute top-1 right-1 flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#009DE0] opacity-60"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[#009DE0]"></span>
              </span>
            )}
          </button>

          {isAlertDropdownOpen && (
            <div className="absolute right-0 mt-2 w-80 bg-white border border-slate-200 rounded-lg shadow-[0_8px_30px_rgb(0,0,0,0.08)] z-50 p-2 animate-in fade-in duration-100">
              <div className="px-2.5 py-1.5 flex items-center justify-between border-b border-slate-100">
                <span className="text-xs font-semibold text-slate-900">Priority Operational Alerts</span>
                <span className="text-[10px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded font-medium">
                  {activeAlertsCount} active
                </span>
              </div>
              <div className="divide-y divide-slate-100/80 py-1 max-h-64 overflow-y-auto">
                <div 
                  onClick={() => { onNavigateToTab('dispatch'); setIsAlertDropdownOpen(false); }}
                  className="p-2.5 hover:bg-slate-50/90 cursor-pointer rounded-md transition-colors group"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-900 group-hover:text-[#009DE0]">
                      7 Orders Pending Dispatch
                    </span>
                    <span className="text-[10px] font-medium text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200/60">
                      Dispatch
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">Orders packed and waiting for rider assignment in busy hubs.</p>
                </div>
                <div 
                  onClick={() => { onNavigateToTab('sellers'); setIsAlertDropdownOpen(false); }}
                  className="p-2.5 hover:bg-slate-50/90 cursor-pointer rounded-md transition-colors group"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-900 group-hover:text-[#009DE0]">
                      2 Partner Stores Offline
                    </span>
                    <span className="text-[10px] font-medium text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                      Stores
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">Merchants temporarily paused fulfillment during standard hours.</p>
                </div>
                <div 
                  onClick={() => { onNavigateToTab('inventory'); setIsAlertDropdownOpen(false); }}
                  className="p-2.5 hover:bg-slate-50/90 cursor-pointer rounded-md transition-colors group"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-900 group-hover:text-[#009DE0]">
                      Low Stock SKUs
                    </span>
                    <span className="text-[10px] font-medium text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200/60">
                      Inventory
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">5 high-velocity items need rapid stock replenishment.</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Compact Admin Avatar Profile */}
        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setIsUserDropdownOpen(!isUserDropdownOpen)}
            className="p-0.5 rounded-full hover:ring-2 hover:ring-[#009DE0]/30 transition-all cursor-pointer focus:outline-none flex items-center"
            title={`${currentUser.name} (${currentUser.roleTitle || currentUser.role})`}
          >
            <img
              src={currentUser.avatar}
              alt={currentUser.name}
              className="h-7 w-7 sm:h-8 sm:w-8 rounded-full object-cover border border-slate-200/90 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
            />
          </button>

          {isUserDropdownOpen && (
            <div className="absolute right-0 mt-2 w-72 bg-white border border-slate-200 rounded-lg shadow-[0_8px_30px_rgb(0,0,0,0.08)] z-50 p-3 animate-in fade-in duration-100">
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
                Active Administrator
              </div>

              <div className="flex items-center gap-3 p-2.5 bg-slate-50/80 border border-slate-200/80 rounded-lg">
                <img
                  src={currentUser.avatar}
                  alt={currentUser.name}
                  className="h-9 w-9 rounded-full object-cover border border-slate-200 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold text-slate-900 truncate">{currentUser.name}</div>
                  <div className="text-[11px] text-slate-500 truncate">{currentUser.email}</div>
                  <span className="text-[10px] text-[#00608a] font-semibold bg-sky-50 border border-sky-200/80 px-1.5 py-0.5 rounded inline-block mt-1">
                    {currentUser.roleTitle || (currentUser.role === 'SUPER_ADMIN' ? 'Super Admin' : currentUser.role.replace(/_/g, ' '))}
                  </span>
                </div>
              </div>

              <div className="mt-3 space-y-1.5 text-xs">
                <div className="flex items-center justify-between py-1 border-b border-slate-100">
                  <span className="text-slate-500 font-medium">Department</span>
                  <span className="font-semibold text-slate-800 text-xs">{currentUser.department}</span>
                </div>
                <div className="flex items-center justify-between py-1">
                  <span className="text-slate-500 font-medium">Session Status</span>
                  <span className="font-semibold text-slate-700 text-xs flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#009DE0] animate-pulse"></span>
                    Active Session
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

import React, { useState, useEffect } from 'react';
import {
  Store,
  CheckCircle2,
  XCircle,
  Clock,
  MapPin,
  TrendingUp,
  Percent,
  RefreshCw,
  Search,
  ShieldCheck,
  Power,
  Sliders,
  FileCheck,
  AlertTriangle,
  Download,
  Plus,
  Edit3,
  Ban,
  RotateCcw,
  Check,
  Star,
  CreditCard
} from 'lucide-react';
import { AdminSeller, AdminPermission } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';
import { exportToCsv } from '../../utils/exportToSheet';
import { SellerApprovalModal } from './SellerApprovalModal';
import { SellerEditModal } from './SellerEditModal';
import { SellerOnboardingModal } from './SellerOnboardingModal';
import { StatusChangeReasonModal } from './StatusChangeReasonModal';
import { SellerLedgerModal } from './SellerLedgerModal';

interface SellerManagementProps {
  userPermissions: AdminPermission[];
  selectedCity?: string;
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
}

export const SellerManagement: React.FC<SellerManagementProps> = ({
  userPermissions,
  selectedCity = 'all',
  searchQuery: externalSearchQuery,
  onSearchQueryChange,
}) => {
  const [sellers, setSellers] = useState<AdminSeller[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'ACTIVE' | 'SUSPENDED' | 'APPLICATIONS' | 'ALL'>('ACTIVE');
  const [searchQuery, setSearchQuery] = useState(externalSearchQuery || '');

  useEffect(() => {
    if (externalSearchQuery !== undefined) {
      setSearchQuery(externalSearchQuery);
    }
  }, [externalSearchQuery]);

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    if (onSearchQueryChange) {
      onSearchQueryChange(val);
    }
  };
  
  const [selectedSellerForApproval, setSelectedSellerForApproval] = useState<AdminSeller | null>(null);
  const [selectedSellerForEdit, setSelectedSellerForEdit] = useState<AdminSeller | null>(null);
  const [selectedSellerForLedger, setSelectedSellerForLedger] = useState<AdminSeller | null>(null);
  const [showOnboardingModal, setShowOnboardingModal] = useState(false);
  const [statusChangeTarget, setStatusChangeTarget] = useState<{
    seller: AdminSeller;
    targetStatus: string;
  } | null>(null);

  const [editingCommissionId, setEditingCommissionId] = useState<string | null>(null);
  const [tempCommission, setTempCommission] = useState<number>(8.5);

  const canApprove = userPermissions.includes('sellers.approve');
  const canSuspend = userPermissions.includes('sellers.suspend');
  const canEditCommission = userPermissions.includes('sellers.edit_commission');
  const canEdit = userPermissions.includes('sellers.edit');
  const canCreate = userPermissions.includes('sellers.create');

  const fetchSellers = async () => {
    try {
      setLoading(true);
      const url = selectedCity && selectedCity !== 'all'
        ? `/api/admin/sellers?city=${selectedCity}`
        : '/api/admin/sellers';
      const res: any = await adminApi.get(url);
      if (res.success) setSellers(res.sellers);
    } catch (err) {
      console.error('Failed to load sellers:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSellers();
  }, [selectedCity]);

  const handleToggleStoreOnline = async (seller: AdminSeller) => {
    if (!canSuspend) return;
    try {
      await adminApi.post(`/api/admin/sellers/${seller.id}/toggle-status`, {
        isStoreOnline: !seller.isStoreOnline,
      });
      fetchSellers();
    } catch (err: any) {
      alert(err.message || 'Action failed');
    }
  };

  const handleToggleReceiveOrders = async (seller: AdminSeller) => {
    if (!canSuspend) return;
    try {
      await adminApi.post(`/api/admin/sellers/${seller.id}/toggle-status`, {
        canReceiveOrders: !seller.canReceiveOrders,
      });
      fetchSellers();
    } catch (err: any) {
      alert(err.message || 'Action failed');
    }
  };

  const handleUpdateCommission = async (sellerId: string) => {
    if (!canEditCommission) return;
    if (tempCommission < 15) {
      alert('Platform commission take rate must be at least 15.0%');
      return;
    }
    try {
      await adminApi.post(`/api/admin/sellers/${sellerId}/update-commission`, {
        commissionRatePercent: tempCommission,
      });
      setEditingCommissionId(null);
      fetchSellers();
    } catch (err: any) {
      alert(err.message || 'Failed to update commission');
    }
  };

  const handleQuickReactivate = (seller: AdminSeller) => {
    setStatusChangeTarget({ seller, targetStatus: 'ACTIVE' });
  };

  const handleConfirmStatusChange = async (reason: string) => {
    if (!statusChangeTarget) return;
    const { seller, targetStatus } = statusChangeTarget;
    if (targetStatus === 'ACTIVE') {
      await adminApi.post(`/api/admin/sellers/${seller.id}/reactivate`, { reason });
    } else {
      await adminApi.post(`/api/admin/sellers/${seller.id}/toggle-status`, {
        status: targetStatus,
        suspensionReason: reason,
        reason,
      });
    }
    fetchSellers();
  };

  // Filtered lists
  const filteredSellers = sellers.filter((s) => {
    // City match is handled by backend or frontend fallback:
    if (selectedCity && selectedCity !== 'all') {
      const matchCity = (s.cityId || '').toLowerCase() === selectedCity.toLowerCase() ||
        (typeof s.address === 'string' ? s.address : s.address?.city || '').toLowerCase().includes(selectedCity.toLowerCase());
      if (!matchCity) return false;
    }

    // Tab filter
    if (activeTab === 'ACTIVE' && s.status !== 'ACTIVE') return false;
    if (activeTab === 'SUSPENDED' && s.status !== 'SUSPENDED') return false;
    if (activeTab === 'APPLICATIONS' && s.status !== 'PENDING_APPROVAL') return false;

    // Search Query filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const matchName = s.name.toLowerCase().includes(query);
      const matchOwner = (s.ownerName || '').toLowerCase().includes(query);
      const matchGstin = (s.gstin || '').toLowerCase().includes(query);
      const matchPhone = (s.phone || '').includes(query);
      const matchHub = (s.hubType || '').toLowerCase().includes(query);
      const matchCategory = (s.categories || []).some((c) => c.toLowerCase().includes(query));
      const matchArea = (s.areaName || '').toLowerCase().includes(query);
      const matchId = (s.id || '').toLowerCase().includes(query);
      return matchName || matchOwner || matchGstin || matchPhone || matchHub || matchCategory || matchArea || matchId;
    }

    return true;
  });

  const activeCount = sellers.filter((s) => s.status === 'ACTIVE').length;
  const suspendedCount = sellers.filter((s) => s.status === 'SUSPENDED').length;
  const pendingCount = sellers.filter((s) => s.status === 'PENDING_APPROVAL').length;

  const handleExportSellers = () => {
    exportToCsv<AdminSeller>('qcom_sellers_merchant_sheet', [
      { header: 'Seller ID', accessor: (s) => s.id },
      { header: 'Store Name', accessor: (s) => s.name },
      { header: 'GSTIN', accessor: (s) => s.gstin },
      { header: 'Owner Name', accessor: (s) => s.ownerName },
      { header: 'Phone', accessor: (s) => s.phone },
      { header: 'Email', accessor: (s) => s.email },
      { header: 'Area Name', accessor: (s) => s.areaName },
      { header: 'Store Categories', accessor: (s) => (s.categories && s.categories.length > 0 ? s.categories.join(', ') : s.hubType) },
      { header: 'Status', accessor: (s) => s.status },
      { header: 'Online', accessor: (s) => s.isStoreOnline ? 'YES' : 'NO' },
      { header: 'Commission Rate %', accessor: (s) => s.commissionRatePercent },
      { header: 'GST Verified', accessor: (s) => s.documents?.gstVerified ? 'VERIFIED' : 'PENDING' },
      { header: 'Total Orders', accessor: (s) => s.totalOrders || 0 },
      { header: 'Rating', accessor: (s) => s.rating || 4.8 },
    ], sellers);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'ACTIVE':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200/80">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Active
          </span>
        );
      case 'SUSPENDED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200/80">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
            Suspended
          </span>
        );
      case 'PENDING_APPROVAL':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200/80">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            Pending Audit
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
            {status}
          </span>
        );
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Partner Stores
          </h1>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            onClick={() => setShowOnboardingModal(true)}
            className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 rounded-md text-xs font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Onboard Store</span>
          </button>

          <button
            onClick={handleExportSellers}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200/90 px-3 py-1.5 rounded-md text-xs font-medium shadow-[0_1px_2px_rgba(0,0,0,0.02)] transition-colors cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-slate-400" />
            <span>Export CSV</span>
          </button>

          <button
            onClick={fetchSellers}
            className="p-1.5 bg-white hover:bg-slate-50 text-slate-700 rounded-md border border-slate-200/90 shadow-[0_1px_2px_rgba(0,0,0,0.02)] transition-colors cursor-pointer"
            title="Refresh Store List"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#009DE0]' : 'text-slate-500'}`} />
          </button>
        </div>
      </div>

      {/* Filter Tabs & Search Bar */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        {/* Filter Tabs */}
        <div className="bg-slate-100/80 p-0.5 rounded-lg flex items-center border border-slate-200/80 text-xs overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveTab('ACTIVE')}
            className={`px-3 py-1.5 rounded-md font-medium transition-all whitespace-nowrap cursor-pointer ${
              activeTab === 'ACTIVE'
                ? 'bg-white text-slate-950 font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Active Stores ({activeCount})
          </button>

          <button
            onClick={() => setActiveTab('APPLICATIONS')}
            className={`px-3 py-1.5 rounded-md font-medium transition-all whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'APPLICATIONS'
                ? 'bg-white text-slate-950 font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span>Pending KYC</span>
            {pendingCount > 0 && (
              <span className="bg-slate-900 text-white text-[10px] px-1.5 py-0.2 rounded-full font-bold">
                {pendingCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('SUSPENDED')}
            className={`px-3 py-1.5 rounded-md font-medium transition-all whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'SUSPENDED'
                ? 'bg-white text-slate-950 font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span>Suspended</span>
            {suspendedCount > 0 && (
              <span className="bg-rose-100 text-rose-800 text-[10px] px-1.5 py-0.2 rounded-full font-bold">
                {suspendedCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('ALL')}
            className={`px-3 py-1.5 rounded-md font-medium transition-all whitespace-nowrap cursor-pointer ${
              activeTab === 'ALL'
                ? 'bg-white text-slate-950 font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            All Stores ({sellers.length})
          </button>
        </div>

        {/* Search Input */}
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Search store name, GSTIN, owner..."
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full bg-white border border-slate-200/90 rounded-md pl-9 pr-3 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#009DE0]/15 focus:border-[#009DE0] shadow-[0_1px_2px_rgba(0,0,0,0.02)] transition-all"
          />
        </div>
      </div>

      {/* SECTION: PENDING KYC APPLICATIONS TAB */}
      {activeTab === 'APPLICATIONS' ? (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200/80 rounded-xl p-5 shadow-2xs">
            <h3 className="font-semibold text-slate-900 text-sm mb-1 flex items-center gap-2">
              <FileCheck className="h-4 w-4 text-slate-700" />
              Merchant Applications Pending Review
            </h3>
            <p className="text-xs text-slate-500 mb-5">
              Review GSTIN validity, PAN authentication, bank account mandates, and trade licenses.
            </p>

            {filteredSellers.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-xs font-medium">
                No pending seller applications match your search query. All KYC queues cleared!
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {filteredSellers.map((app) => (
                  <div
                    key={app.id}
                    className="bg-white border border-slate-200/80 rounded-xl p-4 space-y-3.5 hover:border-slate-300 transition-all shadow-2xs"
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <h4 className="font-bold text-slate-900 text-sm">{app.name}</h4>
                        <span className="bg-amber-50 text-amber-700 border border-amber-200/80 text-[11px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                          Pending Audit
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        {(app.categories && app.categories.length > 0
                          ? app.categories
                          : [app.hubType || 'Hardware & Fasteners']
                        ).map((cat, idx) => (
                          <span
                            key={idx}
                            className="px-2.5 py-0.5 bg-slate-100 text-slate-700 font-medium text-[11px] rounded-md border border-slate-200"
                          >
                            {cat}
                          </span>
                        ))}
                        <span className="text-slate-500 text-xs font-normal ml-0.5">· {app.areaName}</span>
                      </div>
                    </div>

                    <div className="space-y-1 text-xs text-slate-700 bg-slate-50/75 p-3 rounded-lg border border-slate-200/80 font-mono">
                      <div>Owner: <span className="text-slate-900 font-medium font-sans">{app.ownerName}</span></div>
                      <div>Phone: <span className="text-slate-500">{app.phone}</span></div>
                      <div>GSTIN: <span className="text-slate-900 font-semibold">{app.gstin}</span></div>
                      <div>Bank: <span className="text-slate-600">{app.bankAccount?.bankName}</span></div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setSelectedSellerForApproval(app)}
                        className="grow bg-slate-900 hover:bg-slate-800 text-white font-medium py-2 rounded-lg text-xs flex items-center justify-center gap-1.5 transition-all shadow-2xs"
                      >
                        <FileCheck className="h-3.5 w-3.5" />
                        <span>Audit Documents & Decision</span>
                      </button>

                      <button
                        onClick={() => setSelectedSellerForEdit(app)}
                        className="p-2 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded-lg text-xs"
                        title="Edit Store Profile"
                      >
                        <Edit3 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* SECTION: STORES GRID (ACTIVE, SUSPENDED, ALL) */
        <div className="space-y-4">
          {filteredSellers.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-slate-400 text-xs">
              No stores found matching your active tab and search filters.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {filteredSellers.map((seller) => (
                <div
                  key={seller.id}
                  className={`bg-white border rounded-xl p-4 shadow-2xs space-y-3 transition-all ${
                    seller.status === 'SUSPENDED'
                      ? 'border-rose-200 bg-rose-50/10'
                      : 'border-slate-200/80 hover:border-slate-300'
                  }`}
                >
                  {/* Store Header & Redesigned Rating / Orders metric */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-slate-900 text-base tracking-tight">{seller.name}</h3>
                        {getStatusBadge(seller.status)}
                      </div>

                      {/* Store Category Badges - Neutral Slate styling consistent with Operations/Ads */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {(seller.categories && seller.categories.length > 0
                          ? seller.categories
                          : [seller.hubType || 'Hardware & Fasteners']
                        ).map((cat, idx) => (
                          <span
                            key={idx}
                            className="px-2.5 py-0.5 bg-slate-100 text-slate-700 font-medium text-[11px] rounded-md border border-slate-200"
                          >
                            {cat}
                          </span>
                        ))}
                      </div>

                      <p className="text-xs text-slate-500 font-normal leading-relaxed flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span>{typeof seller.address === 'string' ? seller.address : `${seller.areaName}, ${seller.cityId}`}</span>
                      </p>
                    </div>

                    {/* Rating & Order Count Pill - Standard Amber Star Rating */}
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      <div className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-50/80 border border-amber-200/80 text-amber-900">
                        <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-400" />
                        <span className="text-xs font-bold">{seller.rating || 4.8}</span>
                      </div>
                      <span className="text-[11px] text-slate-500 font-medium font-mono">
                        {(seller.totalOrders || 0).toLocaleString()} Orders
                      </span>
                    </div>
                  </div>

                  {/* Suspension Warning Box if Suspended */}
                  {seller.status === 'SUSPENDED' && (
                    <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" />
                        <span>Reason: <strong>{seller.suspensionReason || 'Compliance audit pending'}</strong></span>
                      </div>
                      <button
                        onClick={() => handleQuickReactivate(seller)}
                        className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded text-[11px] shrink-0"
                      >
                        Reactivate
                      </button>
                    </div>
                  )}

                  {/* SLA & Prep Time Performance Metrics */}
                  <div className="grid grid-cols-3 gap-2 bg-slate-50/80 p-2.5 rounded-lg border border-slate-200/80 text-center">
                    <div>
                      <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider block mb-0.5">Avg Prep Time</span>
                      <span className="text-xs font-bold text-slate-900">{seller.avgPrepTimeMins} mins</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider block mb-0.5">SLA Rate</span>
                      <span className="text-xs font-bold text-emerald-700">{seller.slaAdherencePercent}%</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider block mb-0.5">Active Orders</span>
                      <span className="text-xs font-bold text-slate-900">{seller.activeOrdersCount || 0}</span>
                    </div>
                  </div>

                  {/* Store Controls (Online / Ordering / Commission) */}
                  <div className="p-3 bg-slate-50/75 rounded-lg border border-slate-200/80 space-y-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-600 font-medium">Store Availability:</span>
                      <button
                        onClick={() => handleToggleStoreOnline(seller)}
                        disabled={!canSuspend}
                        className={`px-2.5 py-0.5 rounded text-[11px] font-medium transition-colors ${
                          seller.isStoreOnline
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60 font-bold'
                            : 'bg-slate-200/80 text-slate-600'
                        }`}
                      >
                        {seller.isStoreOnline ? 'Online' : 'Offline'}
                      </button>
                    </div>

                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-600 font-medium">Receive Orders:</span>
                      <button
                        onClick={() => handleToggleReceiveOrders(seller)}
                        disabled={!canSuspend}
                        className={`px-2.5 py-0.5 rounded text-[11px] font-medium transition-colors ${
                          seller.canReceiveOrders
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60 font-bold'
                            : 'bg-slate-200/80 text-slate-600'
                        }`}
                      >
                        {seller.canReceiveOrders ? 'Enabled' : 'Paused'}
                      </button>
                    </div>

                    {/* Commission Editor */}
                    <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-200/80">
                      <span className="text-slate-600 font-medium">Marketplace Commission:</span>
                      {editingCommissionId === seller.id ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            step="0.1"
                            min="15"
                            max="50"
                            value={tempCommission}
                            onChange={(e) => setTempCommission(Number(e.target.value))}
                            className="w-16 bg-white border border-slate-200 rounded px-1.5 py-0.5 text-xs text-slate-900 font-mono"
                          />
                          <button
                            onClick={() => handleUpdateCommission(seller.id)}
                            className="bg-slate-900 text-white font-medium px-2 py-0.5 rounded text-[11px]"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingCommissionId(null)}
                            className="text-slate-400 hover:text-slate-700 text-[11px]"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-slate-900 font-medium">{seller.commissionRatePercent}%</span>
                          {canEditCommission && (
                            <button
                              onClick={() => {
                                setEditingCommissionId(seller.id);
                                setTempCommission(seller.commissionRatePercent);
                              }}
                              className="text-slate-500 hover:text-slate-900 text-[11px]"
                            >
                              Edit
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Bottom Action Footer for Card */}
                  <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="font-mono text-[11px] text-slate-500">
                      GST: <span className="font-bold text-slate-800">{seller.gstin}</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setSelectedSellerForLedger(seller)}
                        className="px-2.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-semibold border border-indigo-200/80 rounded-lg text-xs flex items-center gap-1.5 transition-all shadow-2xs"
                        title="View Full Sales & Settlement Dashboard"
                      >
                        <CreditCard className="h-3.5 w-3.5 text-indigo-600" />
                        <span>Sales & Ledger</span>
                      </button>

                      <button
                        onClick={() => setSelectedSellerForEdit(seller)}
                        className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-lg text-xs flex items-center gap-1.5 transition-all shadow-2xs"
                      >
                        <Sliders className="h-3.5 w-3.5" />
                        <span>Manage</span>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Seller Approval Modal */}
      {selectedSellerForApproval && (
        <SellerApprovalModal
          seller={selectedSellerForApproval}
          onClose={() => setSelectedSellerForApproval(null)}
          onRefresh={fetchSellers}
          canApprove={canApprove}
        />
      )}

      {/* Seller Edit & Full Control Modal */}
      {selectedSellerForEdit && (
        <SellerEditModal
          seller={selectedSellerForEdit}
          onClose={() => setSelectedSellerForEdit(null)}
          onRefresh={fetchSellers}
          canEdit={canEdit}
          canSuspend={canSuspend}
          canEditCommission={canEditCommission}
        />
      )}

      {/* Seller Comprehensive Sales & Settlement Ledger Modal */}
      {selectedSellerForLedger && (
        <SellerLedgerModal
          seller={selectedSellerForLedger}
          onClose={() => setSelectedSellerForLedger(null)}
          onSellerUpdated={() => fetchSellers()}
          userPermissions={userPermissions}
        />
      )}

      {/* Onboard New Partner Store Modal */}
      {showOnboardingModal && (
        <SellerOnboardingModal
          onClose={() => setShowOnboardingModal(false)}
          onRefresh={fetchSellers}
          canCreate={canCreate}
        />
      )}

      {/* Status Change Reason Modal */}
      {statusChangeTarget && (
        <StatusChangeReasonModal
          sellerName={statusChangeTarget.seller.name}
          currentStatus={statusChangeTarget.seller.status}
          targetStatus={statusChangeTarget.targetStatus}
          onClose={() => setStatusChangeTarget(null)}
          onConfirm={handleConfirmStatusChange}
        />
      )}
    </div>
  );
};


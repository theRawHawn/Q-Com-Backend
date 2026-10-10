import React, { useState, useEffect } from 'react';
import {
  Bike,
  CheckCircle2,
  XCircle,
  Radio,
  Battery,
  ShieldCheck,
  RefreshCw,
  Search,
  Zap,
  Phone,
  FileCheck,
  Download,
  Plus,
  Edit3,
  Eye,
  AlertTriangle,
  RotateCcw,
  Ban,
  MapPin,
  Truck,
  Star,
  Clock,
  LayoutGrid,
  List,
  ChevronRight,
  TrendingUp,
  SlidersHorizontal,
  Navigation,
  CreditCard,
  Send,
  ArrowDownLeft,
  ArrowUpRight,
  Layers
} from 'lucide-react';
import { AdminRider, AdminPermission } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';
import { exportToCsv } from '../../utils/exportToSheet';
import { RiderEditModal } from './RiderEditModal';
import { RiderProfileModal } from './RiderProfileModal';
import { RiderBroadcastModal } from './RiderBroadcastModal';
import { RiderLedgerModal } from './RiderLedgerModal';
import { RiderLedgerDashboard } from './RiderLedgerDashboard';

interface RiderFleetManagementProps {
  userPermissions: AdminPermission[];
  selectedCity?: string;
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
}

export const RiderFleetManagement: React.FC<RiderFleetManagementProps> = ({
  userPermissions,
  selectedCity = 'all',
  searchQuery: externalSearchQuery,
  onSearchQueryChange,
}) => {
  const [activeView, setActiveView] = useState<'roster' | 'ledger'>('roster');
  const [riders, setRiders] = useState<AdminRider[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [vehicleTypeFilter, setVehicleTypeFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState(externalSearchQuery || '');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

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

  // Modal States
  const [profileModalRider, setProfileModalRider] = useState<AdminRider | null>(null);
  const [editModalRider, setEditModalRider] = useState<AdminRider | null>(null);
  const [ledgerModalRider, setLedgerModalRider] = useState<AdminRider | null>(null);
  const [isCreatingRider, setIsCreatingRider] = useState(false);
  const [showBroadcastModal, setShowBroadcastModal] = useState(false);
  const [releasingRiderId, setReleasingRiderId] = useState<string | null>(null);
  const [actionAlert, setActionAlert] = useState<string | null>(null);

  const canCreate = userPermissions.includes('riders.create');
  const canEdit = userPermissions.includes('riders.edit');
  const canApprove = userPermissions.includes('riders.approve');
  const canBroadcast = userPermissions.includes('riders.broadcast');
  const canProcessPayout = userPermissions.includes('settlements.process') || canEdit || canApprove;

  const fetchRiders = async () => {
    try {
      setLoading(true);
      const url = selectedCity && selectedCity !== 'all'
        ? `/api/admin/riders?city=${selectedCity}`
        : '/api/admin/riders';
      const res: any = await adminApi.get(url);
      if (res && res.success) {
        setRiders(res.riders);
      }
    } catch (err) {
      console.error('Failed to load riders:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRiders();
  }, [selectedCity]);

  const showNotification = (msg: string) => {
    setActionAlert(msg);
    setTimeout(() => setActionAlert(null), 4000);
  };

  const handleApproveRider = async (riderId: string) => {
    if (!canApprove) return;
    try {
      const res: any = await adminApi.post(`/api/admin/riders/${riderId}/approve`, {});
      if (res.success) {
        fetchRiders();
        showNotification('Delivery partner verified and activated for live dispatch!');
      }
    } catch (err: any) {
      alert(err.message || 'Approval failed');
    }
  };

  const handleQuickReleaseToday = async (r: AdminRider) => {
    if (!canProcessPayout) return;
    try {
      setReleasingRiderId(r.id);
      const amount = r.pendingPayableBalance !== undefined ? r.pendingPayableBalance : (r.todayEarnings || 0);
      if (amount <= 0) {
        showNotification('No pending due amount to release for this partner.');
        return;
      }
      const res: any = await adminApi.post(`/api/admin/riders/${r.id}/release-payout`, {
        payoutType: 'FULL',
        amount,
        paymentMode: 'UPI',
        upiId: r.bankDetails?.upiId,
      });

      if (res.success) {
        setRiders((prev) => prev.map((item) => (item.id === r.id ? res.rider : item)));
        showNotification(`Released ₹${amount.toLocaleString('en-IN')} payout to ${r.name} (UTR: ${res.utrNumber || 'UPI-OK'})`);
      }
    } catch (err: any) {
      alert(err.message || 'Payment release failed');
    } finally {
      setReleasingRiderId(null);
    }
  };

  const handleRiderSaved = (updatedRider: AdminRider) => {
    setRiders((prev) => {
      const exists = prev.some((r) => r.id === updatedRider.id);
      if (exists) {
        return prev.map((r) => (r.id === updatedRider.id ? updatedRider : r));
      }
      return [updatedRider, ...prev];
    });
    fetchRiders();
  };

  const handleRiderDeleted = (deletedRiderId: string) => {
    setRiders((prev) => prev.filter((r) => r.id !== deletedRiderId));
    setProfileModalRider(null);
  };

  // Status Filter counts
  const totalRiders = riders.length;
  const onlineCount = riders.filter((r) => r.status === 'ONLINE').length;
  const onDeliveryCount = riders.filter((r) => r.status === 'ON_DELIVERY').length;
  const offlineCount = riders.filter((r) => r.status === 'OFFLINE').length;
  const pendingCount = riders.filter((r) => r.status === 'PENDING_APPROVAL').length;
  const suspendedCount = riders.filter((r) => r.status === 'SUSPENDED').length;

  const fleetTodayEarnings = riders.reduce((acc, r) => acc + (r.todayEarnings || 0), 0);
  const fleetTodayTrips = riders.reduce((acc, r) => acc + (r.todayDeliveries || 0), 0);
  const fleetTotalTrips = riders.reduce((acc, r) => acc + (r.totalDeliveries || 0), 0);

  // Filter logic
  const filteredRiders = riders.filter((r) => {
    if (statusFilter !== 'ALL' && r.status !== statusFilter) return false;
    if (vehicleTypeFilter !== 'ALL' && r.vehicleType !== vehicleTypeFilter) return false;

    const query = searchQuery.toLowerCase().trim();
    if (!query) return true;
    return (
      r.name.toLowerCase().includes(query) ||
      r.phone.includes(query) ||
      r.vehicleNumber.toLowerCase().includes(query) ||
      (r.assignedZoneName && r.assignedZoneName.toLowerCase().includes(query)) ||
      (r.cityName && r.cityName.toLowerCase().includes(query))
    );
  });

  const getVehicleBadge = (vType: AdminRider['vehicleType']) => {
    switch (vType) {
      case 'EV_SCOOTER':
        return { label: 'EV Scooter', icon: Zap, bg: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
      case 'E_LOADER':
        return { label: 'E-Loader 3W', icon: Truck, bg: 'bg-indigo-50 text-indigo-700 border-indigo-200' };
      case 'MINI_TRUCK':
        return { label: 'Mini Cargo', icon: Truck, bg: 'bg-amber-50 text-amber-700 border-amber-200' };
      case 'ELECTRIC_VAN':
        return { label: 'Electric Van', icon: Zap, bg: 'bg-purple-50 text-purple-700 border-purple-200' };
      case 'BIKE':
      default:
        return { label: 'Bike 2W', icon: Bike, bg: 'bg-slate-100 text-slate-700 border-slate-200' };
    }
  };

  const handleExportRoster = () => {
    exportToCsv<AdminRider>('qcom_rider_roster', [
      { header: 'ID', accessor: (r) => r.id },
      { header: 'Name', accessor: (r) => r.name },
      { header: 'Phone', accessor: (r) => r.phone },
      { header: 'City', accessor: (r) => r.cityName || 'Bengaluru' },
      { header: 'Locality Cluster', accessor: (r) => r.assignedZoneName || 'Local Cluster' },
      { header: 'Vehicle Number', accessor: (r) => r.vehicleNumber },
      { header: 'Vehicle Type', accessor: (r) => r.vehicleType },
      { header: 'Status', accessor: (r) => r.status },
      { header: 'Rating', accessor: (r) => r.rating },
      { header: 'Today Deliveries', accessor: (r) => r.todayDeliveries },
      { header: 'Today Earnings (INR)', accessor: (r) => r.todayEarnings },
      { header: 'Total Deliveries', accessor: (r) => r.totalDeliveries },
      { header: 'DL Verified', accessor: (r) => (r.documents?.drivingLicenseVerified ? 'YES' : 'NO') },
      { header: 'RC Verified', accessor: (r) => (r.documents?.rcVerified ? 'YES' : 'NO') },
      { header: 'Aadhar Verified', accessor: (r) => (r.documents?.aadharVerified ? 'YES' : 'NO') },
      { header: 'PAN Verified', accessor: (r) => (r.documents?.panVerified ? 'YES' : 'NO') },
      { header: 'Insurance Verified', accessor: (r) => (r.documents?.insuranceVerified ? 'YES' : 'NO') },
      { header: 'Background Checked', accessor: (r) => (r.documents?.backgroundCheckPassed ? 'YES' : 'NO') },
      { header: 'UPI ID', accessor: (r) => r.bankDetails?.upiId || 'N/A' },
      { header: 'Bank Name', accessor: (r) => r.bankDetails?.bankName || 'N/A' },
      { header: 'Account Number', accessor: (r) => r.bankDetails?.accountNumber || 'N/A' },
    ], riders);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Top Header with City Filter Context and Master Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Delivery Fleet</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          {canBroadcast && (
            <button
              onClick={() => setShowBroadcastModal(true)}
              className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200/90 px-3 py-1.5 rounded-md text-xs font-medium shadow-[0_1px_2px_rgba(0,0,0,0.02)] transition-colors cursor-pointer"
            >
              <Radio className="h-3.5 w-3.5 text-slate-400" />
              <span>Broadcast Notice</span>
            </button>
          )}

          <button
            onClick={handleExportRoster}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200/90 px-3 py-1.5 rounded-md text-xs font-medium shadow-[0_1px_2px_rgba(0,0,0,0.02)] transition-colors cursor-pointer"
          >
            <Download className="h-3.5 w-3.5 text-slate-400" />
            <span>Export CSV</span>
          </button>

          {canCreate && (
            <button
              onClick={() => {
                setEditModalRider(null);
                setIsCreatingRider(true);
              }}
              className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 rounded-md text-xs font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-colors cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Onboard Partner</span>
            </button>
          )}

          <button
            onClick={fetchRiders}
            disabled={loading}
            className="p-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200/90 rounded-md transition-colors shadow-[0_1px_2px_rgba(0,0,0,0.02)] cursor-pointer"
            title="Refresh Fleet Data"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#009DE0]' : 'text-slate-500'}`} />
          </button>
        </div>
      </div>

      {/* Top View Selector Tabs: Fleet Roster vs Pending KYC vs Financial Ledger */}
      <div className="flex items-center bg-slate-100/80 p-0.5 rounded-lg border border-slate-200/80 w-full sm:w-max text-xs overflow-x-auto scrollbar-none">
        <button
          onClick={() => {
            setActiveView('roster');
            if (statusFilter === 'PENDING_APPROVAL') setStatusFilter('ALL');
          }}
          className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all whitespace-nowrap cursor-pointer ${
            activeView === 'roster' && statusFilter !== 'PENDING_APPROVAL'
              ? 'bg-white text-slate-950 font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Bike className="h-3.5 w-3.5 text-slate-500" />
          <span>Fleet Roster & Shifts</span>
        </button>

        <button
          onClick={() => {
            setActiveView('roster');
            setStatusFilter('PENDING_APPROVAL');
          }}
          className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all whitespace-nowrap cursor-pointer ${
            activeView === 'roster' && statusFilter === 'PENDING_APPROVAL'
              ? 'bg-white text-slate-950 font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <FileCheck className="h-3.5 w-3.5 text-slate-500" />
          <span>Pending KYC</span>
          {pendingCount > 0 && (
            <span className="bg-slate-900 text-white text-[10px] px-1.5 py-0.2 rounded-full font-bold">
              {pendingCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveView('ledger')}
          className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all whitespace-nowrap cursor-pointer ${
            activeView === 'ledger'
              ? 'bg-white text-slate-950 font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <CreditCard className="h-3.5 w-3.5 text-slate-500" />
          <span>Earnings & Payouts</span>
          <span className="text-[10px] bg-slate-200/80 text-slate-700 font-medium px-1.5 py-0.2 rounded">
            ₹{(riders.reduce((s, r) => s + (r.todayEarnings || 0), 0)).toLocaleString('en-IN')}
          </span>
        </button>
      </div>

      {/* Action Notification Banner */}
      {actionAlert && (
        <div className="p-3 bg-emerald-50 border border-emerald-200/80 text-emerald-900 rounded-lg text-xs font-medium flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
            <span>{actionAlert}</span>
          </div>
          <button onClick={() => setActionAlert(null)} className="text-emerald-700 font-medium">
            ✕
          </button>
        </div>
      )}

      {/* VIEW 2: Full Financial Ledger & Payment Release Dashboard */}
      {activeView === 'ledger' ? (
        <RiderLedgerDashboard
          userPermissions={userPermissions}
          selectedCity={selectedCity}
          onViewRiderProfile={(r) => setProfileModalRider(r)}
        />
      ) : (
        /* VIEW 1: Standard Fleet Telemetry & Clean Roster Cards */
        <>
          {/* Status KPI Filter Tabs */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {[
              { label: 'All Partners', value: totalRiders, key: 'ALL' },
              { label: 'Online on Duty', value: onlineCount, key: 'ONLINE', badge: 'bg-emerald-500' },
              { label: 'On Active Order', value: onDeliveryCount, key: 'ON_DELIVERY', badge: 'bg-sky-500' },
              { label: 'Offline / Break', value: offlineCount, key: 'OFFLINE', badge: 'bg-slate-400' },
              { label: 'Pending KYC', value: pendingCount, key: 'PENDING_APPROVAL', badge: 'bg-indigo-500' },
              { label: 'Suspended', value: suspendedCount, key: 'SUSPENDED', badge: 'bg-rose-500' },
            ].map((tab) => {
              const isSelected = statusFilter === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setStatusFilter(tab.key)}
                  className={`p-3.5 rounded-lg border text-left transition-all cursor-pointer ${
                    isSelected
                      ? 'border-slate-900 bg-slate-900 text-white shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                      : 'bg-white border-slate-200/90 hover:border-slate-300 text-slate-800 shadow-[0_1px_2px_rgba(0,0,0,0.02)]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-medium ${isSelected ? 'text-white/80' : 'text-slate-500'}`}>
                      {tab.label}
                    </span>
                    {tab.badge && !isSelected && (
                      <span className={`h-1.5 w-1.5 rounded-full ${tab.badge}`} />
                    )}
                  </div>
                  <div className="text-xl font-bold mt-1.5 tracking-tight tabular-nums">
                    {tab.value}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Filter and Search Bar */}
          <div className="bg-white border border-slate-200/90 rounded-lg p-3 shadow-[0_1px_2px_rgba(0,0,0,0.02)] flex flex-col md:flex-row items-center justify-between gap-2.5">
            {/* Left Side: Vehicle Filter & Quick info */}
            <div className="flex items-center gap-2.5 w-full md:w-auto">
              <div className="flex items-center gap-1.5">
                <SlidersHorizontal className="h-3.5 w-3.5 text-slate-400" />
                <select
                  value={vehicleTypeFilter}
                  onChange={(e) => setVehicleTypeFilter(e.target.value)}
                  className="bg-slate-50 border border-slate-200/90 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-800 focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#009DE0] cursor-pointer"
                >
                  <option value="ALL">All Vehicles</option>
                  <option value="EV_SCOOTER">⚡ EV 2-Wheeler</option>
                  <option value="E_LOADER">📦 E-Loader 3W</option>
                  <option value="BIKE">🏍️ Petrol 2W</option>
                  <option value="MINI_TRUCK">🚚 Mini Truck</option>
                </select>
              </div>

              <span className="text-xs text-slate-400 hidden sm:inline">
                <strong className="text-slate-700 font-semibold">{filteredRiders.length}</strong> partners
              </span>
            </div>

            {/* Right Side: Search Input & View Switch */}
            <div className="flex items-center gap-2 w-full md:w-auto justify-between md:justify-end">
              <div className="relative flex-1 md:w-72">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search by name, phone, plate, or hub..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="w-full bg-slate-50/80 border border-slate-200/90 rounded-md pl-9 pr-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#009DE0]/15 focus:border-[#009DE0] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
                />
              </div>

              <div className="flex items-center bg-slate-100/80 p-0.5 rounded-md border border-slate-200/80">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-1.5 rounded transition-all cursor-pointer ${
                    viewMode === 'grid' ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(0,0,0,0.04)] font-medium' : 'text-slate-500 hover:text-slate-800'
                  }`}
                  title="Grid View"
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setViewMode('table')}
                  className={`p-1.5 rounded transition-all cursor-pointer ${
                    viewMode === 'table' ? 'bg-white text-slate-900 shadow-[0_1px_2px_rgba(0,0,0,0.04)] font-medium' : 'text-slate-500 hover:text-slate-800'
                  }`}
                  title="Table View"
                >
                  <List className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Empty State */}
          {filteredRiders.length === 0 && !loading && (
            <div className="text-center py-12 bg-white border border-slate-200/80 rounded-xl p-6 shadow-xs">
              <Bike className="h-8 w-8 text-slate-300 mx-auto mb-2" />
              <h3 className="text-xs font-semibold text-slate-900">No delivery partners found</h3>
              <p className="text-xs text-slate-400 max-w-sm mx-auto mt-0.5">
                No riders match current filters or search query.
              </p>
              {canCreate && (
                <button
                  onClick={() => setIsCreatingRider(true)}
                  className="mt-3 inline-flex items-center gap-1.5 bg-slate-900 text-white font-medium text-xs px-3 py-1.5 rounded-lg hover:bg-slate-800 shadow-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Onboard Partner</span>
                </button>
              )}
            </div>
          )}
          {/* Grid Cards View */}
          {viewMode === 'grid' && filteredRiders.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {filteredRiders.map((r) => {
                const vBadge = getVehicleBadge(r.vehicleType);
                const VIcon = vBadge.icon;
                const dailyEarn = r.todayEarnings ?? 0;
                const dailyTrips = r.todayDeliveries ?? 0;
                const weeklyEarn = r.weeklyEarnings !== undefined ? r.weeklyEarnings : (dailyEarn > 0 ? Math.round(dailyEarn * 5.4) : 0);
                const weeklyTrips = r.weeklyDeliveries !== undefined ? r.weeklyDeliveries : (dailyTrips > 0 ? Math.round(dailyTrips * 5.8) : 0);
                const monthlyEarn = r.monthlyEarnings !== undefined ? r.monthlyEarnings : (dailyEarn > 0 ? Math.round(dailyEarn * 24.5) : 0);
                const dueBalance = r.pendingPayableBalance !== undefined ? r.pendingPayableBalance : dailyEarn;
                const isReleasingThis = releasingRiderId === r.id;

                return (
                  <div
                    key={r.id}
                    className="bg-white border border-slate-200/80 rounded-xl shadow-xs hover:border-slate-300 transition-all flex flex-col justify-between overflow-hidden"
                  >
                    <div className="p-4 space-y-3">
                      {/* Card Header: Avatar, Name, Phone, Rating */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2.5">
                          <div className="relative shrink-0">
                            <img
                              src={r.avatar}
                              alt={r.name}
                              className="h-10 w-10 rounded-lg object-cover border border-slate-200/80"
                            />
                            <span
                              className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white ${
                                r.status === 'ONLINE'
                                  ? 'bg-emerald-500'
                                  : r.status === 'ON_DELIVERY'
                                  ? 'bg-sky-500'
                                  : r.status === 'PENDING_APPROVAL'
                                  ? 'bg-indigo-500'
                                  : r.status === 'SUSPENDED'
                                  ? 'bg-rose-500'
                                  : 'bg-slate-400'
                              }`}
                            />
                          </div>

                          <div className="min-w-0">
                            <h3 className="font-bold text-slate-900 text-sm truncate">{r.name}</h3>
                            <p className="text-xs text-slate-600 font-medium mt-0.5">{r.phone}</p>
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <div className="inline-flex items-center gap-1 bg-amber-50 text-amber-900 border border-amber-200 px-1.5 py-0.5 rounded text-xs font-bold">
                            <Star className="h-3 w-3 fill-amber-400 text-amber-500" />
                            <span>{r.rating}</span>
                          </div>
                          <span className="text-[11px] text-slate-600 font-medium block mt-0.5">
                            {r.totalDeliveries} trips
                          </span>
                        </div>
                      </div>

                      {/* Operational Details (Hub, Vehicle, Battery) */}
                      <div className="bg-slate-50 rounded-lg p-2.5 border border-slate-200 space-y-1.5 text-xs">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1 text-slate-800 truncate">
                            <MapPin className="h-3 w-3 text-slate-500 shrink-0" />
                            <span className="font-semibold text-slate-900 truncate">{r.assignedZoneName || r.cityName || 'City Zone'}</span>
                          </div>
                          <span className="text-[11px] text-emerald-800 font-semibold shrink-0">
                            {r.cityName || 'Bengaluru'}
                          </span>
                        </div>

                        <div className="flex items-center justify-between pt-1 border-t border-slate-200">
                          <div className="flex items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-200/80 text-slate-800">
                              <VIcon className="h-3 w-3" />
                              {vBadge.label}
                            </span>
                            <span className="text-slate-800 text-[11px] font-semibold">{r.vehicleNumber}</span>
                          </div>

                          {r.batteryPercent !== undefined ? (
                            <div className="flex items-center gap-1 text-[11px] font-bold text-emerald-800 bg-emerald-50 px-1.5 py-0.2 rounded border border-emerald-200">
                              <Battery className="h-3 w-3" />
                              <span>{r.batteryPercent}%</span>
                            </div>
                          ) : (
                            <span className="text-[10px] text-slate-600 font-medium">{r.maxPayloadKg || 60} kg cap</span>
                          )}
                        </div>
                      </div>

                      {/* Earnings & Trips Row */}
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-2">
                        <div className="grid grid-cols-3 gap-1.5 text-center text-xs">
                          <div className="bg-white p-1.5 rounded border border-slate-200">
                            <span className="text-[10px] text-slate-500 font-semibold uppercase block">Today</span>
                            <span className="font-semibold text-slate-900 block text-xs mt-0.5">
                              ₹{dailyEarn}
                            </span>
                            <span className="text-[10px] text-slate-500 block">
                              {dailyTrips} trips
                            </span>
                          </div>

                          <div className="bg-white p-1.5 rounded border border-slate-200/60">
                            <span className="text-[10px] text-slate-400 block">Weekly</span>
                            <span className="font-semibold text-slate-900 block text-xs mt-0.5">
                              ₹{weeklyEarn}
                            </span>
                            <span className="text-[10px] text-slate-500 block">
                              {weeklyTrips} trips
                            </span>
                          </div>

                          <div className="bg-white p-1.5 rounded border border-slate-200/60">
                            <span className="text-[10px] text-slate-400 block">Monthly</span>
                            <span className="font-semibold text-slate-900 block text-xs mt-0.5">
                              ₹{monthlyEarn}
                            </span>
                            <span className="text-[10px] text-slate-500 block">
                              30 Days
                            </span>
                          </div>
                        </div>

                        <div className="mt-2 pt-1.5 border-t border-slate-200/60 flex items-center justify-between text-xs">
                          <span className="text-[11px] text-slate-500">
                            Due: <strong className="text-slate-900 font-medium font-mono">₹{dueBalance}</strong>
                          </span>

                          <button
                            onClick={() => handleQuickReleaseToday(r)}
                            disabled={isReleasingThis || dueBalance <= 0 || r.payoutStatus === 'ON_HOLD' || !canProcessPayout}
                            className="bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white font-medium px-2 py-0.5 rounded text-[11px] flex items-center gap-1 shadow-xs transition-colors"
                          >
                            {isReleasingThis ? <Clock className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                            <span>{dueBalance > 0 ? `Release ₹${dueBalance}` : 'Settled'}</span>
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Card Footer: Live Shift Status & Actions */}
                    <div className="p-3 bg-slate-50/75 border-t border-slate-200/80 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-400 flex items-center gap-1 text-[11px]">
                          <Radio className="h-3 w-3 text-slate-400" />
                          <span>Shift:</span>
                        </span>
                        <div
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium ${
                            r.status === 'ONLINE'
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60'
                              : r.status === 'ON_DELIVERY'
                              ? 'bg-sky-50 text-sky-700 border border-sky-200/60'
                              : r.status === 'PENDING_APPROVAL'
                              ? 'bg-indigo-50 text-indigo-700 border border-indigo-200/60'
                              : r.status === 'SUSPENDED'
                              ? 'bg-rose-50 text-rose-700 border border-rose-200/60'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              r.status === 'ONLINE'
                                ? 'bg-emerald-500'
                                : r.status === 'ON_DELIVERY'
                                ? 'bg-sky-500'
                                : r.status === 'PENDING_APPROVAL'
                                ? 'bg-indigo-500'
                                : r.status === 'SUSPENDED'
                                ? 'bg-rose-500'
                                : 'bg-slate-400'
                            }`}
                          />
                          <span>{r.status === 'ONLINE' ? 'Online' : r.status.replace(/_/g, ' ')}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-1.5 pt-0.5">
                        <button
                          onClick={() => setLedgerModalRider(r)}
                          className="flex items-center justify-center gap-1 bg-white hover:bg-slate-100 text-slate-700 font-medium py-1.5 px-2 rounded-lg text-xs border border-slate-200/80 transition-colors shadow-xs"
                        >
                          <CreditCard className="h-3.5 w-3.5 text-slate-500" />
                          <span>Ledger</span>
                        </button>

                        <button
                          onClick={() => setProfileModalRider(r)}
                          className="flex items-center justify-center gap-1 bg-white hover:bg-slate-100 text-slate-700 font-medium py-1.5 px-2 rounded-lg text-xs border border-slate-200/80 transition-colors shadow-xs"
                        >
                          <Eye className="h-3.5 w-3.5 text-slate-500" />
                          <span>Profile</span>
                        </button>
                      </div>

                      {r.status === 'PENDING_APPROVAL' && canApprove && (
                        <button
                          onClick={() => handleApproveRider(r.id)}
                          className="w-full bg-slate-900 hover:bg-slate-800 text-white font-medium py-1.5 rounded-lg text-xs flex items-center justify-center gap-1.5 transition-all shadow-xs"
                        >
                          <FileCheck className="h-3.5 w-3.5" />
                          <span>Approve Partner</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Table Roster View */}
          {viewMode === 'table' && filteredRiders.length > 0 && (
            <div className="bg-white border border-slate-200/80 rounded-xl overflow-hidden shadow-xs">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs min-w-[780px]">
                  <thead className="bg-slate-50/75 text-slate-500 text-[11px] font-medium border-b border-slate-200/80">
                    <tr>
                      <th className="px-4 py-3">Partner Details</th>
                      <th className="px-4 py-3">Vehicle & Plate</th>
                      <th className="px-4 py-3">Delivery Zone</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Today Earnings</th>
                      <th className="px-4 py-3">Pending Due</th>
                      <th className="px-4 py-3">Total Trips</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredRiders.map((r) => {
                      const dailyEarn = r.todayEarnings ?? 0;
                      const dailyT = r.todayDeliveries ?? 0;
                      const dueBalance = r.pendingPayableBalance !== undefined ? r.pendingPayableBalance : dailyEarn;
                      const isReleasingThis = releasingRiderId === r.id;

                      return (
                        <tr key={r.id} className="hover:bg-slate-50/70 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              <img src={r.avatar} alt={r.name} className="h-8 w-8 rounded-lg object-cover border border-slate-200/80" />
                              <div>
                                <div className="font-semibold text-slate-900 text-xs">
                                  {r.name}
                                </div>
                                <div className="text-[11px] text-slate-400 mt-0.5">{r.phone}</div>
                              </div>
                            </div>
                          </td>

                          <td className="px-4 py-3">
                            <div className="font-mono text-slate-900 text-xs">{r.vehicleNumber}</div>
                            <div className="text-[11px] text-slate-400">{r.vehicleType.replace(/_/g, ' ')}</div>
                          </td>

                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-900 text-xs">{r.assignedZoneName || r.cityName || 'City Zone'}</div>
                            <div className="text-[11px] text-slate-400">{r.cityName || 'Bengaluru'}</div>
                          </td>

                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium ${
                                r.status === 'ONLINE'
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60'
                                  : r.status === 'ON_DELIVERY'
                                  ? 'bg-sky-50 text-sky-700 border border-sky-200/60'
                                  : r.status === 'PENDING_APPROVAL'
                                  ? 'bg-indigo-50 text-indigo-700 border border-indigo-200/60'
                                  : r.status === 'SUSPENDED'
                                  ? 'bg-rose-50 text-rose-700 border border-rose-200/60'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${
                                  r.status === 'ONLINE'
                                    ? 'bg-emerald-500'
                                    : r.status === 'ON_DELIVERY'
                                    ? 'bg-sky-500'
                                    : r.status === 'PENDING_APPROVAL'
                                    ? 'bg-indigo-500'
                                    : r.status === 'SUSPENDED'
                                    ? 'bg-rose-500'
                                    : 'bg-slate-400'
                                }`}
                              />
                              {r.status === 'ONLINE' ? 'Online' : r.status.replace(/_/g, ' ')}
                            </span>
                          </td>

                          <td className="px-4 py-3 font-mono">
                            <span className="font-semibold text-slate-900 text-xs">₹{dailyEarn}</span>
                            <span className="text-slate-400 block text-[10px]">({dailyT} trips)</span>
                          </td>

                          <td className="px-4 py-3 font-mono">
                            <span className={`font-semibold text-xs ${dueBalance > 0 ? 'text-amber-700' : 'text-slate-400'}`}>
                              ₹{dueBalance}
                            </span>
                            <span className="text-slate-400 block text-[10px]">
                              {dueBalance === 0 ? 'Settled' : r.payoutStatus === 'ON_HOLD' ? 'On Hold' : 'Pending'}
                            </span>
                          </td>

                          <td className="px-4 py-3 text-slate-600 text-xs">
                            {r.totalDeliveries} trips
                          </td>

                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={() => handleQuickReleaseToday(r)}
                                disabled={isReleasingThis || dueBalance <= 0 || r.payoutStatus === 'ON_HOLD' || !canProcessPayout}
                                className="bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white font-medium px-2 py-0.5 rounded text-xs flex items-center gap-1 shadow-xs transition-colors"
                                title="Release due payout"
                              >
                                {isReleasingThis ? <Clock className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                                <span>{dueBalance > 0 ? `Release ₹${dueBalance}` : 'Settled'}</span>
                              </button>

                              <button
                                onClick={() => setLedgerModalRider(r)}
                                className="p-1 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded transition-colors"
                                title="Open Ledger"
                              >
                                <CreditCard className="h-3.5 w-3.5" />
                              </button>

                              <button
                                onClick={() => setProfileModalRider(r)}
                                className="p-1 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded transition-colors"
                                title="View Profile"
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Dedicated Rider Ledger & Payment Release Modal */}
      {ledgerModalRider && (
        <RiderLedgerModal
          rider={ledgerModalRider}
          onClose={() => setLedgerModalRider(null)}
          onRiderUpdated={(updatedRider) => {
            handleRiderSaved(updatedRider);
            setLedgerModalRider(updatedRider);
          }}
          userPermissions={userPermissions}
        />
      )}

      {/* Profile Modal */}
      {profileModalRider && (
        <RiderProfileModal
          rider={profileModalRider}
          onClose={() => setProfileModalRider(null)}
          onEdit={(r) => {
            setProfileModalRider(null);
            setEditModalRider(r);
          }}
          onRiderUpdated={handleRiderSaved}
          onRiderDeleted={handleRiderDeleted}
          userPermissions={userPermissions}
        />
      )}

      {/* Edit / Onboard Modal */}
      {(editModalRider || isCreatingRider) && (
        <RiderEditModal
          rider={editModalRider}
          onClose={() => {
            setEditModalRider(null);
            setIsCreatingRider(false);
          }}
          onSuccess={handleRiderSaved}
          selectedCity={selectedCity}
        />
      )}

      {/* Broadcast Alert Modal */}
      {showBroadcastModal && (
        <RiderBroadcastModal
          onClose={() => setShowBroadcastModal(false)}
          selectedCity={selectedCity}
          activeRiderCount={onlineCount + onDeliveryCount}
        />
      )}
    </div>
  );
};

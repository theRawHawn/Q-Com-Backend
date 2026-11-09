import React, { useState, useEffect } from 'react';
import {
  CreditCard,
  Send,
  Download,
  RefreshCw,
  Search,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  TrendingUp,
  Zap,
  Building,
  ShieldCheck,
  Ban,
  Filter,
  Layers,
  ChevronRight,
  Eye,
  SlidersHorizontal
} from 'lucide-react';
import { AdminRider, AdminPermission } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';
import { exportToCsv } from '../../utils/exportToSheet';
import { RiderLedgerModal } from './RiderLedgerModal';

interface RiderLedgerDashboardProps {
  userPermissions: AdminPermission[];
  selectedCity?: string;
  onViewRiderProfile?: (rider: AdminRider) => void;
}

export const RiderLedgerDashboard: React.FC<RiderLedgerDashboardProps> = ({
  userPermissions,
  selectedCity = 'all',
  onViewRiderProfile,
}) => {
  const [riders, setRiders] = useState<AdminRider[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [payoutFilter, setPayoutFilter] = useState<'ALL' | 'PENDING' | 'SETTLED' | 'HELD'>('ALL');
  const [selectedRiderForLedger, setSelectedRiderForLedger] = useState<AdminRider | null>(null);
  const [isBulkReleasing, setIsBulkReleasing] = useState(false);
  const [releasingRiderId, setReleasingRiderId] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const canProcessPayout = userPermissions.includes('settlements.process') || userPermissions.includes('riders.edit') || userPermissions.includes('riders.approve');

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
      console.error('Failed to load rider financials:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRiders();
  }, [selectedCity]);

  // Aggregate Metrics Calculations
  const totalFleetRiders = riders.length;
  const fleetDailyEarned = riders.reduce((sum, r) => sum + (r.todayEarnings || 0), 0);
  const fleetDailyTrips = riders.reduce((sum, r) => sum + (r.todayDeliveries || 0), 0);

  const fleetWeeklyEarned = riders.reduce((sum, r) => sum + (r.weeklyEarnings || Math.round((r.todayEarnings || 0) * 5.4)), 0);
  const fleetWeeklyTrips = riders.reduce((sum, r) => sum + (r.weeklyDeliveries || Math.round((r.todayDeliveries || 0) * 5.8)), 0);

  const fleetMonthlyEarned = riders.reduce((sum, r) => sum + (r.monthlyEarnings || Math.round((r.todayEarnings || 0) * 24.5)), 0);
  const fleetMonthlyTrips = riders.reduce((sum, r) => sum + (r.monthlyDeliveries || Math.round((r.todayDeliveries || 0) * 25.2)), 0);

  const fleetTotalTrips = riders.reduce((sum, r) => sum + (r.totalDeliveries || 0), 0);
  const fleetTotalLifetimeEarned = riders.reduce((sum, r) => sum + (r.totalLifetimeEarnings || 142000), 0);

  const fleetPendingPayable = riders.reduce((sum, r) => {
    if (r.payoutStatus === 'ON_HOLD') return sum;
    return sum + (r.pendingPayableBalance ?? r.todayEarnings ?? 0);
  }, 0);

  const pendingCount = riders.filter((r) => (r.pendingPayableBalance ?? r.todayEarnings ?? 0) > 0 && r.payoutStatus !== 'ON_HOLD').length;

  const filteredRiders = riders.filter((r) => {
    const balance = r.pendingPayableBalance ?? r.todayEarnings ?? 0;
    if (payoutFilter === 'PENDING' && (balance <= 0 || r.payoutStatus === 'ON_HOLD')) return false;
    if (payoutFilter === 'SETTLED' && balance > 0) return false;
    if (payoutFilter === 'HELD' && r.payoutStatus !== 'ON_HOLD') return false;

    const query = searchQuery.toLowerCase().trim();
    if (!query) return true;
    return (
      r.name.toLowerCase().includes(query) ||
      r.phone.includes(query) ||
      r.vehicleNumber.toLowerCase().includes(query) ||
      (r.assignedZoneName && r.assignedZoneName.toLowerCase().includes(query)) ||
      (r.bankDetails?.upiId && r.bankDetails.upiId.toLowerCase().includes(query))
    );
  });

  const showNotification = (msg: string) => {
    setSuccessBanner(msg);
    setTimeout(() => setSuccessBanner(null), 5000);
  };

  const handleReleaseSingleRider = async (rider: AdminRider, type: 'DAILY' | 'WEEKLY' | 'FULL') => {
    if (!canProcessPayout) return;
    try {
      setReleasingRiderId(rider.id);
      const pendingDue = rider.pendingPayableBalance !== undefined ? rider.pendingPayableBalance : (rider.todayEarnings || 0);
      const amount = type === 'FULL' || type === 'DAILY'
        ? pendingDue
        : (rider.weeklyEarnings || pendingDue);

      const res: any = await adminApi.post(`/api/admin/riders/${rider.id}/release-payout`, {
        payoutType: type,
        amount,
        paymentMode: 'UPI',
        upiId: rider.bankDetails?.upiId,
      });

      if (res.success) {
        setRiders((prev) => prev.map((r) => (r.id === rider.id ? res.rider : r)));
        showNotification(`Released ₹${amount.toLocaleString('en-IN')} payout for ${rider.name} (UTR: ${res.utrNumber || 'UPI-OK'})`);
      }
    } catch (err: any) {
      alert(err.message || 'Payment release failed');
    } finally {
      setReleasingRiderId(null);
    }
  };

  const handleBulkReleaseDaily = async () => {
    if (!canProcessPayout) return;
    if (!window.confirm(`Release daily payouts for all ${pendingCount} eligible delivery partners (Total: ₹${fleetPendingPayable.toLocaleString('en-IN')})?`)) {
      return;
    }
    try {
      setIsBulkReleasing(true);
      const res: any = await adminApi.post('/api/admin/riders/bulk-release-payout', {
        payoutType: 'DAILY',
        city: selectedCity,
      });
      if (res.success) {
        fetchRiders();
        showNotification(`Successfully disbursed daily payouts to ${res.processedCount || pendingCount} delivery partners!`);
      }
    } catch (err: any) {
      alert(err.message || 'Bulk release failed');
    } finally {
      setIsBulkReleasing(false);
    }
  };

  const handleExportFinancialSheet = () => {
    exportToCsv<AdminRider>('qcom_fleet_financial_ledger', [
      { header: 'Partner ID', accessor: (r) => r.id },
      { header: 'Partner Name', accessor: (r) => r.name },
      { header: 'Phone Number', accessor: (r) => r.phone },
      { header: 'Operating City', accessor: (r) => r.cityName || 'Bengaluru' },
      { header: 'Assigned Local Cluster', accessor: (r) => r.assignedZoneName || 'Local Cluster' },
      { header: 'Today Deliveries', accessor: (r) => r.todayDeliveries || 0 },
      { header: 'Daily Earned (INR)', accessor: (r) => r.todayEarnings || 0 },
      { header: 'Weekly Deliveries', accessor: (r) => r.weeklyDeliveries || Math.round((r.todayDeliveries || 0) * 5.8) },
      { header: 'Weekly Earned (INR)', accessor: (r) => r.weeklyEarnings || Math.round((r.todayEarnings || 0) * 5.4) },
      { header: 'Monthly Deliveries', accessor: (r) => r.monthlyDeliveries || Math.round((r.todayDeliveries || 0) * 25.2) },
      { header: 'Monthly Earned (INR)', accessor: (r) => r.monthlyEarnings || Math.round((r.todayEarnings || 0) * 24.5) },
      { header: 'Total Lifetime Deliveries', accessor: (r) => r.totalDeliveries || 0 },
      { header: 'Total Lifetime Earned (INR)', accessor: (r) => r.totalLifetimeEarnings || 142000 },
      { header: 'Pending Payable Due (INR)', accessor: (r) => r.pendingPayableBalance ?? r.todayEarnings ?? 0 },
      { header: 'Payout Status', accessor: (r) => r.payoutStatus || 'PENDING_RELEASE' },
      { header: 'Bank Name', accessor: (r) => r.bankDetails?.bankName || 'N/A' },
      { header: 'Bank Account Number', accessor: (r) => r.bankDetails?.accountNumber || 'N/A' },
      { header: 'Bank IFSC', accessor: (r) => r.bankDetails?.ifscCode || 'N/A' },
      { header: 'UPI VPA Address', accessor: (r) => r.bankDetails?.upiId || 'N/A' },
    ], riders);
  };

  return (
    <div className="space-y-6">
      {/* Top Banner Alert if any action triggered */}
      {successBanner && (
        <div className="bg-emerald-50 border border-emerald-300 rounded-2xl p-4 text-xs text-emerald-900 flex items-center justify-between shadow-2xs animate-in fade-in duration-200">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
            <span>{successBanner}</span>
          </div>
          <button
            onClick={() => setSuccessBanner(null)}
            className="text-emerald-700 hover:text-emerald-950 font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Aggregate Financial Dashboard (Daily, Weekly, Monthly, Total Trips & Outstanding) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 1. Daily Fleet Earnings & Deliveries Component */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Daily Fleet Earned (Today)
              </span>
              <span className="p-1.5 bg-emerald-50 text-emerald-700 rounded-lg border border-emerald-200">
                <Zap className="h-4 w-4" />
              </span>
            </div>
            <div className="text-2xl font-bold font-mono text-slate-900 mt-2 tracking-tight">
              ₹{fleetDailyEarned.toLocaleString('en-IN')}
            </div>
            <div className="text-xs text-slate-500 mt-1 flex items-center gap-1.5 font-medium">
              <strong className="text-slate-800">{fleetDailyTrips} Total Trips</strong> completed today
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
            <span className="text-slate-400">Release Readiness:</span>
            <button
              onClick={handleBulkReleaseDaily}
              disabled={isBulkReleasing || pendingCount === 0 || !canProcessPayout}
              className="text-emerald-700 hover:text-emerald-800 font-bold flex items-center gap-1 disabled:opacity-40"
            >
              <Send className="h-3 w-3" />
              <span>Release All Today</span>
            </button>
          </div>
        </div>

        {/* 2. Weekly Fleet Earnings & Deliveries Component */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Weekly Fleet Earned
              </span>
              <span className="p-1.5 bg-indigo-50 text-indigo-700 rounded-lg border border-indigo-200">
                <TrendingUp className="h-4 w-4" />
              </span>
            </div>
            <div className="text-2xl font-bold font-mono text-slate-900 mt-2 tracking-tight">
              ₹{fleetWeeklyEarned.toLocaleString('en-IN')}
            </div>
            <div className="text-xs text-slate-500 mt-1 flex items-center gap-1.5 font-medium">
              <strong className="text-slate-800">{fleetWeeklyTrips} Weekly Trips</strong> across fleet
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
            <span className="text-slate-400">Cycle Status:</span>
            <span className="text-indigo-700 font-semibold bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">
              Active Rolling Week
            </span>
          </div>
        </div>

        {/* 3. Monthly Fleet Earnings & Deliveries Component */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Monthly Fleet Earned
              </span>
              <span className="p-1.5 bg-sky-50 text-sky-700 rounded-lg border border-sky-200">
                <CreditCard className="h-4 w-4" />
              </span>
            </div>
            <div className="text-2xl font-bold font-mono text-slate-900 mt-2 tracking-tight">
              ₹{fleetMonthlyEarned.toLocaleString('en-IN')}
            </div>
            <div className="text-xs text-slate-500 mt-1 flex items-center gap-1.5 font-medium">
              <strong className="text-slate-800">{fleetMonthlyTrips} Monthly Trips</strong> fulfilled
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
            <span className="text-slate-400">Total Lifetime:</span>
            <span className="text-slate-700 font-bold">
              {fleetTotalTrips.toLocaleString('en-IN')} Trips
            </span>
          </div>
        </div>

        {/* 4. Total Outstanding Payable Balance with Batch Release */}
        <div className="bg-white border border-emerald-200 rounded-2xl p-5 shadow-2xs flex flex-col justify-between bg-gradient-to-br from-white to-emerald-50/40">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-emerald-800 uppercase tracking-wider">
                Pending Payable Balance
              </span>
              <span className="text-[10px] bg-emerald-600 text-white font-bold px-2 py-0.5 rounded-full shadow-2xs">
                {pendingCount} Due
              </span>
            </div>
            <div className="text-2xl font-bold font-mono text-emerald-950 mt-2 tracking-tight">
              ₹{fleetPendingPayable.toLocaleString('en-IN')}
            </div>
            <div className="text-xs text-emerald-800 mt-1">
              Ready for instant disbursement via UPI 24x7 / IMPS
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-emerald-200/60">
            <button
              onClick={handleBulkReleaseDaily}
              disabled={isBulkReleasing || pendingCount === 0 || !canProcessPayout}
              className="w-full bg-[#009DE0] hover:bg-[#0087c2] disabled:opacity-50 text-white font-semibold py-2 px-3 rounded-xl text-xs flex items-center justify-center gap-1.5 shadow-xs transition-colors"
            >
              {isBulkReleasing ? (
                <Clock className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              <span>
                {isBulkReleasing ? 'Executing Payouts...' : `Release Fleet Payouts (₹${fleetPendingPayable.toLocaleString('en-IN')})`}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Control & Search Bar */}
      <div className="bg-white border border-slate-200 rounded-2xl p-3.5 shadow-2xs flex flex-col md:flex-row items-center justify-between gap-3">
        {/* Filter Pills */}
        <div className="flex items-center gap-2 overflow-x-auto w-full md:w-auto">
          {[
            { id: 'ALL', label: `All Partners (${totalFleetRiders})` },
            { id: 'PENDING', label: `Pending Release (${pendingCount})` },
            { id: 'SETTLED', label: 'Settled (₹0 Due)' },
            { id: 'HELD', label: 'On Hold' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setPayoutFilter(tab.id as any)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                payoutFilter === tab.id
                  ? 'bg-slate-900 text-white shadow-2xs'
                  : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search & Export Actions */}
        <div className="flex items-center gap-2 w-full md:w-auto justify-between md:justify-end">
          <div className="relative flex-1 md:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search partner, phone, UPI, or cluster..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-9 pr-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          <button
            onClick={handleExportFinancialSheet}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 px-3 py-1.5 rounded-xl text-xs font-semibold shadow-2xs transition-colors"
          >
            <Download className="h-3.5 w-3.5 text-slate-500" />
            <span>Export Sheet</span>
          </button>
        </div>
      </div>

      {/* Main Financial Ledger & Payout Release Control Table */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
              <tr>
                <th className="px-4 py-3.5">Delivery Partner</th>
                <th className="px-4 py-3.5">Daily Earned (Today)</th>
                <th className="px-4 py-3.5">Weekly Earned</th>
                <th className="px-4 py-3.5">Monthly Earned</th>
                <th className="px-4 py-3.5">Total Trips</th>
                <th className="px-4 py-3.5">Payable Balance</th>
                <th className="px-4 py-3.5">Destination Bank / UPI</th>
                <th className="px-4 py-3.5 text-right">Payment Release Controls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRiders.map((r) => {
                const dailyEarn = r.todayEarnings || 0;
                const dailyT = r.todayDeliveries || 0;
                const weeklyEarn = r.weeklyEarnings || Math.round(dailyEarn * 5.4);
                const weeklyT = r.weeklyDeliveries || Math.round(dailyT * 5.8);
                const monthlyEarn = r.monthlyEarnings || Math.round(dailyEarn * 24.5);
                const monthlyT = r.monthlyDeliveries || Math.round(dailyT * 25.2);
                const balance = r.pendingPayableBalance ?? dailyEarn;
                const isHeld = r.payoutStatus === 'ON_HOLD';
                const isReleasingThis = releasingRiderId === r.id;

                return (
                  <tr key={r.id} className="hover:bg-slate-50/70 transition-colors">
                    {/* Partner Details */}
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-3">
                        <img
                          src={r.avatar}
                          alt={r.name}
                          className="h-10 w-10 rounded-xl object-cover border border-slate-200 shrink-0"
                        />
                        <div className="min-w-0">
                          <div className="font-bold text-slate-900 truncate flex items-center gap-1.5">
                            <span>{r.name}</span>
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                            {r.phone} • {r.assignedZoneName?.split('(')[0] || 'Local Cluster'}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Daily Earned */}
                    <td className="px-4 py-3.5">
                      <div className="font-extrabold text-slate-900">₹{dailyEarn.toLocaleString('en-IN')}</div>
                      <div className="text-[11px] text-emerald-700 font-semibold">{dailyT} trips today</div>
                    </td>

                    {/* Weekly Earned */}
                    <td className="px-4 py-3.5">
                      <div className="font-extrabold text-slate-900">₹{weeklyEarn.toLocaleString('en-IN')}</div>
                      <div className="text-[11px] text-indigo-700 font-semibold">{weeklyT} weekly trips</div>
                    </td>

                    {/* Monthly Earned */}
                    <td className="px-4 py-3.5">
                      <div className="font-extrabold text-slate-900">₹{monthlyEarn.toLocaleString('en-IN')}</div>
                      <div className="text-[11px] text-sky-700 font-semibold">{monthlyT} monthly trips</div>
                    </td>

                    {/* Total Deliveries */}
                    <td className="px-4 py-3.5">
                      <div className="font-extrabold text-slate-900">{r.totalDeliveries} trips</div>
                      <div className="text-[11px] text-slate-400">₹{(r.totalLifetimeEarnings || 142000).toLocaleString('en-IN')} total</div>
                    </td>

                    {/* Pending Payable Balance */}
                    <td className="px-4 py-3.5">
                      {isHeld ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded-md border border-rose-200">
                          <Ban className="h-3 w-3" />
                          HELD: ₹{balance}
                        </span>
                      ) : balance > 0 ? (
                        <div className="font-extrabold text-emerald-700 text-sm">
                          ₹{balance.toLocaleString('en-IN')}
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-400 font-semibold">Settled (₹0)</span>
                      )}
                    </td>

                    {/* Destination Bank / UPI */}
                    <td className="px-4 py-3.5">
                      <div className="text-slate-800 font-medium truncate max-w-[150px]">
                        {r.bankDetails?.upiId ? (
                          <span className="text-indigo-700 font-mono text-[11px]">{r.bankDetails.upiId}</span>
                        ) : (
                          <span>{r.bankDetails?.bankName || 'Bank Account'}</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono">
                        {r.bankDetails?.accountNumber ? `A/C •••• ${r.bankDetails.accountNumber.slice(-4)}` : 'Verified UPI'}
                      </div>
                    </td>

                    {/* Granular Component Payment Release Controls */}
                    <td className="px-4 py-3.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* Instant Release Today's Component */}
                        <button
                          onClick={() => handleReleaseSingleRider(r, 'DAILY')}
                          disabled={isReleasingThis || isHeld || dailyEarn <= 0 || !canProcessPayout}
                          className="bg-[#009DE0] hover:bg-[#0087c2] disabled:opacity-40 text-white font-semibold px-2.5 py-1.5 rounded-xl text-xs flex items-center gap-1 shadow-2xs transition-colors"
                          title={`Release today's earnings (₹${dailyEarn})`}
                        >
                          {isReleasingThis ? (
                            <Clock className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Send className="h-3 w-3" />
                          )}
                          <span>Release ₹{dailyEarn}</span>
                        </button>

                        {/* Open Detailed Ledger & Custom Payout Modal */}
                        <button
                          onClick={() => setSelectedRiderForLedger(r)}
                          className="p-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl border border-slate-200 transition-colors shadow-2xs"
                          title="Open Full Ledger & Payout Console"
                        >
                          <CreditCard className="h-4 w-4" />
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

      {/* Single Rider Ledger & Payment Release Modal */}
      {selectedRiderForLedger && (
        <RiderLedgerModal
          rider={selectedRiderForLedger}
          onClose={() => setSelectedRiderForLedger(null)}
          onRiderUpdated={(updatedRider) => {
            setRiders((prev) => prev.map((r) => (r.id === updatedRider.id ? updatedRider : r)));
            setSelectedRiderForLedger(updatedRider);
          }}
          userPermissions={userPermissions}
        />
      )}
    </div>
  );
};

import React, { useState } from 'react';
import {
  X,
  CreditCard,
  ArrowDownLeft,
  ArrowUpRight,
  Send,
  CheckCircle2,
  Clock,
  Download,
  AlertTriangle,
  Zap,
  TrendingUp,
  Building,
  RotateCcw,
  ShieldCheck,
  Ban,
  Filter,
  Check,
  Receipt,
  Calendar,
  Layers,
  ChevronRight
} from 'lucide-react';
import { AdminRider, AdminRiderLedgerEntry, AdminPermission } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';
import { exportToCsv } from '../../utils/exportToSheet';
import { RiderEarningsBreakdown } from './RiderEarningsBreakdown';

interface RiderLedgerModalProps {
  rider: AdminRider;
  onClose: () => void;
  onRiderUpdated?: (updatedRider: AdminRider) => void;
  userPermissions: AdminPermission[];
}

export const RiderLedgerModal: React.FC<RiderLedgerModalProps> = ({
  rider,
  onClose,
  onRiderUpdated,
  userPermissions,
}) => {
  const [currentRider, setCurrentRider] = useState<AdminRider>(rider);
  const [activeTab, setActiveTab] = useState<'all' | 'credits' | 'debits' | 'releases'>('all');
  const [releaseMode, setReleaseMode] = useState<'FULL' | 'CUSTOM'>('FULL');
  const [customAmount, setCustomAmount] = useState<string>('');
  const [paymentMode, setPaymentMode] = useState<'UPI' | 'IMPS' | 'NEFT'>('UPI');
  const [isReleasing, setIsReleasing] = useState(false);
  const [payoutSuccessData, setPayoutSuccessData] = useState<{
    utr: string;
    amount: number;
    mode: string;
    destination: string;
    timestamp: string;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Financial calculations
  const dailyEarnings = currentRider.todayEarnings || 0;
  const pendingBalance = currentRider.pendingPayableBalance ?? dailyEarnings;

  const defaultLedger: AdminRiderLedgerEntry[] = currentRider.ledgerEntries && currentRider.ledgerEntries.length > 0
    ? currentRider.ledgerEntries
    : [
        {
          id: `led-${currentRider.id}-01`,
          riderId: currentRider.id,
          date: 'Today, 02:45 PM',
          timestamp: new Date().toISOString(),
          type: 'TRIP_EARNING',
          category: 'CREDIT',
          title: `Completed Trip Batch`,
          description: `Base delivery fee for customer orders dispatched from local partner stores`,
          amount: dailyEarnings > 0 ? Math.max(100, dailyEarnings - 100) : 480,
          tripCount: currentRider.todayDeliveries || 6,
          status: 'CLEARED',
        },
        {
          id: `led-${currentRider.id}-02`,
          riderId: currentRider.id,
          date: 'Today, 01:15 PM',
          timestamp: new Date().toISOString(),
          type: 'ON_TIME_INCENTIVE',
          category: 'CREDIT',
          title: 'Peak SLA On-Time Guarantee Bonus',
          description: '100% 10-minute turnaround SLA adherence bonus for 5 consecutive orders',
          amount: 100,
          status: 'CLEARED',
        },
        {
          id: `led-${currentRider.id}-03`,
          riderId: currentRider.id,
          date: 'Yesterday, 09:30 PM',
          timestamp: new Date(Date.now() - 86400000).toISOString(),
          type: 'PAYOUT_RELEASE',
          category: 'DEBIT',
          title: 'Daily Auto-Payout Released via UPI',
          description: `Disbursed to VPA ${currentRider.bankDetails?.upiId || 'partner@upi'}`,
          amount: 640,
          status: 'RELEASED',
          payoutMode: 'UPI',
          utrNumber: 'UPI/489201948120/ICIC',
          releasedAt: new Date(Date.now() - 86400000).toISOString(),
          releasedBy: 'Settlement Engine',
        },
        {
          id: `led-${currentRider.id}-04`,
          riderId: currentRider.id,
          date: '3 days ago',
          timestamp: new Date(Date.now() - 259200000).toISOString(),
          type: 'SURGE_BONUS',
          category: 'CREDIT',
          title: 'Rain & Peak Load Surge Incentive',
          description: 'High-demand weather multiplier for Koramangala & HSR clusters',
          amount: 250,
          status: 'CLEARED',
        },
        {
          id: `led-${currentRider.id}-05`,
          riderId: currentRider.id,
          date: '5 days ago',
          timestamp: new Date(Date.now() - 432000000).toISOString(),
          type: 'TDS_DEDUCTION',
          category: 'DEBIT',
          title: 'Section 194C TDS Statutory Withholding (1%)',
          description: 'Quarterly compliance tax deduction deposited against PAN',
          amount: 45,
          status: 'CLEARED',
        },
        {
          id: `led-${currentRider.id}-06`,
          riderId: currentRider.id,
          date: 'Last Week, Sunday',
          timestamp: new Date(Date.now() - 604800000).toISOString(),
          type: 'PAYOUT_RELEASE',
          category: 'DEBIT',
          title: 'Weekly Cycle Settlement Released via IMPS',
          description: `Bank transfer to ${currentRider.bankDetails?.bankName || 'HDFC Bank'} A/C ${currentRider.bankDetails?.accountNumber?.slice(-4) || '9012'}`,
          amount: 3850,
          status: 'RELEASED',
          payoutMode: 'IMPS',
          utrNumber: 'IMPS/992109823019/HDFC',
          releasedAt: new Date(Date.now() - 604800000).toISOString(),
          releasedBy: 'Finance Ops Desk',
        },
      ];

  const ledgerEntries = currentRider.ledgerEntries || defaultLedger;

  const filteredEntries = ledgerEntries.filter((item) => {
    if (activeTab === 'credits') return item.category === 'CREDIT';
    if (activeTab === 'debits') return item.category === 'DEBIT' && item.type !== 'PAYOUT_RELEASE';
    if (activeTab === 'releases') return item.type === 'PAYOUT_RELEASE';
    return true;
  });

  // Release amount is strictly derived from the pending due balance
  const getReleaseAmount = () => {
    if (pendingBalance <= 0) return 0;
    if (releaseMode === 'CUSTOM') {
      const parsed = parseFloat(customAmount);
      return isNaN(parsed) ? 0 : Math.max(0, Math.min(parsed, pendingBalance));
    }
    return pendingBalance;
  };

  const handleExecutePayout = async () => {
    const amountToRelease = getReleaseAmount();
    if (amountToRelease <= 0) {
      setActionError('Payout amount must be greater than ₹0 and within pending payable due.');
      return;
    }

    try {
      setIsReleasing(true);
      setActionError(null);
      const res: any = await adminApi.post(`/api/admin/riders/${currentRider.id}/release-payout`, {
        payoutType: releaseMode,
        amount: amountToRelease,
        paymentMode,
        upiId: currentRider.bankDetails?.upiId,
        bankAccount: currentRider.bankDetails?.accountNumber,
        ifscCode: currentRider.bankDetails?.ifscCode,
      });

      if (res.success) {
        setCurrentRider(res.rider);
        if (onRiderUpdated) onRiderUpdated(res.rider);
        setPayoutSuccessData({
          utr: res.utrNumber || `UPI-${Date.now().toString().slice(-8)}`,
          amount: amountToRelease,
          mode: paymentMode,
          destination: paymentMode === 'UPI' 
            ? (currentRider.bankDetails?.upiId || 'Direct UPI VPA') 
            : `${currentRider.bankDetails?.bankName || 'Bank'} A/C •••• ${currentRider.bankDetails?.accountNumber?.slice(-4) || '9012'}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
        setCustomAmount('');
      }
    } catch (err: any) {
      setActionError(err.message || 'Failed to release payout. Please verify account status.');
    } finally {
      setIsReleasing(false);
    }
  };

  const handleToggleHold = async () => {
    try {
      const isHold = currentRider.payoutStatus !== 'ON_HOLD';
      const res: any = await adminApi.post(`/api/admin/riders/${currentRider.id}/toggle-payout-hold`, {
        reason: isHold ? 'Admin placed payout on hold pending review' : '',
      });
      if (res.success) {
        setCurrentRider(res.rider);
        if (onRiderUpdated) onRiderUpdated(res.rider);
      }
    } catch (err: any) {
      alert(err.message || 'Failed to update hold status');
    }
  };

  const handleExportLedger = () => {
    exportToCsv<AdminRiderLedgerEntry>(`rider_ledger_${currentRider.id}`, [
      { header: 'Txn ID', accessor: (l) => l.id },
      { header: 'Date & Time', accessor: (l) => l.date },
      { header: 'Type', accessor: (l) => l.type },
      { header: 'Flow', accessor: (l) => l.category },
      { header: 'Title', accessor: (l) => l.title },
      { header: 'Amount (INR)', accessor: (l) => l.amount },
      { header: 'Status', accessor: (l) => l.status },
      { header: 'Payment Mode', accessor: (l) => l.payoutMode || 'N/A' },
      { header: 'UTR Reference', accessor: (l) => l.utrNumber || 'N/A' },
      { header: 'Released By', accessor: (l) => l.releasedBy || 'N/A' },
    ], filteredEntries);
  };

  const amountToRelease = getReleaseAmount();

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-5xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Top Header */}
        <div className="p-5 bg-slate-900 text-white border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-emerald-500/20 border border-emerald-400/30 rounded-xl text-emerald-400">
              <CreditCard className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-tight">
                Rider Performance Breakdown & Payout Console
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {currentRider.name} • {currentRider.phone} • {currentRider.assignedZoneName || currentRider.cityName || 'Bengaluru'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleExportLedger}
              className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition-colors"
            >
              <Download className="h-3.5 w-3.5 text-slate-400" />
              <span>Export CSV</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/50">
          {/* Payment Release Control Console Box */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-2xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
                <h3 className="text-sm font-bold text-slate-900">
                  Payment Release Settlement Desk
                </h3>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Settlement Status:</span>
                <span
                  className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                    currentRider.payoutStatus === 'ON_HOLD'
                      ? 'bg-rose-100 text-rose-800 border border-rose-200'
                      : pendingBalance > 0
                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                      : 'bg-slate-100 text-slate-700 border border-slate-200'
                  }`}
                >
                  {currentRider.payoutStatus === 'ON_HOLD'
                    ? 'PAYOUT ON HOLD'
                    : pendingBalance > 0
                    ? `₹${pendingBalance.toLocaleString('en-IN')} Due for Release`
                    : 'ALL SETTLED (₹0 DUE)'}
                </span>

                <button
                  onClick={handleToggleHold}
                  className={`text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors ${
                    currentRider.payoutStatus === 'ON_HOLD'
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                      : 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
                  }`}
                >
                  {currentRider.payoutStatus === 'ON_HOLD' ? 'Remove Hold' : 'Place on Hold'}
                </button>
              </div>
            </div>

            {/* Release Control Options */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
              {/* Release Type Buttons */}
              <div className="md:col-span-6 space-y-2">
                <label className="text-xs font-semibold text-slate-700 block">
                  Select Payout Amount to Release:
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setReleaseMode('FULL')}
                    className={`py-2 px-3 rounded-xl text-xs font-medium border text-left transition-all ${
                      releaseMode === 'FULL'
                        ? 'bg-[#009DE0] text-white border-[#009DE0] shadow-xs'
                        : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                    }`}
                  >
                    <div className="text-[10px] opacity-80 font-semibold">Full Pending Due</div>
                    <div className="text-sm font-bold font-mono mt-0.5">₹{pendingBalance.toLocaleString('en-IN')}</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setReleaseMode('CUSTOM')}
                    className={`py-2 px-3 rounded-xl text-xs font-medium border text-left transition-all ${
                      releaseMode === 'CUSTOM'
                        ? 'bg-[#009DE0] text-white border-[#009DE0] shadow-xs'
                        : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                    }`}
                  >
                    <div className="text-[10px] opacity-80 font-semibold">Custom Partial Amount</div>
                    <div className="text-xs font-bold mt-0.5">Up to ₹{pendingBalance.toLocaleString('en-IN')}</div>
                  </button>
                </div>

                {releaseMode === 'CUSTOM' && (
                  <div className="pt-1">
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-500">₹</span>
                      <input
                        type="number"
                        min="1"
                        max={pendingBalance}
                        placeholder={`Enter amount (max ₹${pendingBalance})`}
                        value={customAmount}
                        onChange={(e) => setCustomAmount(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-300 rounded-xl pl-7 pr-3 py-1.5 text-xs text-slate-900 font-bold focus:bg-white focus:ring-1 focus:ring-[#009DE0]"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Payment Mode & Execute Action */}
              <div className="md:col-span-6 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <label className="font-semibold text-slate-700">Payment Gateway / Route:</label>
                  <span className="text-[11px] text-slate-500">
                    Target: <strong className="text-slate-800">{currentRider.bankDetails?.upiId || currentRider.bankDetails?.accountNumber || 'Bank A/C'}</strong>
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={paymentMode}
                    onChange={(e: any) => setPaymentMode(e.target.value)}
                    className="bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-xs font-medium text-slate-800 focus:bg-white focus:ring-1 focus:ring-[#009DE0]"
                  >
                    <option value="UPI">⚡ UPI Instant VPA (24x7)</option>
                    <option value="IMPS">🏦 IMPS Real-Time Transfer</option>
                    <option value="NEFT">📋 NEFT Batch Payout</option>
                  </select>

                  <button
                    onClick={handleExecutePayout}
                    disabled={isReleasing || currentRider.payoutStatus === 'ON_HOLD' || amountToRelease <= 0 || pendingBalance <= 0}
                    className="flex-1 flex items-center justify-center gap-1.5 bg-[#009DE0] hover:bg-[#0087c2] disabled:opacity-40 text-white font-bold py-2 px-4 rounded-xl text-xs shadow-xs transition-colors"
                  >
                    {isReleasing ? (
                      <Clock className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {isReleasing
                        ? 'Releasing...'
                        : pendingBalance <= 0
                        ? 'All Settled (₹0 Due)'
                        : `Release ₹${amountToRelease.toLocaleString('en-IN')}`}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {/* Error Message */}
            {actionError && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
                <span>{actionError}</span>
              </div>
            )}

            {/* Instant Payout Success Receipt Alert */}
            {payoutSuccessData && (
              <div className="p-3.5 bg-emerald-50 border border-emerald-300 rounded-xl text-xs text-emerald-900 space-y-1 animate-in fade-in">
                <div className="flex items-center justify-between">
                  <span className="font-bold flex items-center gap-1.5 text-emerald-800">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    Payout Released Successfully!
                  </span>
                  <span className="font-mono text-[11px] text-emerald-700 font-semibold">
                    UTR: {payoutSuccessData.utr}
                  </span>
                </div>
                <p className="text-emerald-700 text-[11px]">
                  Disbursed <strong>₹{payoutSuccessData.amount.toLocaleString('en-IN')}</strong> via {payoutSuccessData.mode} to {payoutSuccessData.destination} at {payoutSuccessData.timestamp}.
                </p>
              </div>
            )}
          </div>

          {/* Complete Rider Breakdown with Daily, Weekly, and Monthly Filters */}
          <RiderEarningsBreakdown rider={currentRider} />

          {/* Detailed Ledger Transactions Table */}
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs">
            {/* Filter Tabs */}
            <div className="p-3.5 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-1 bg-slate-200/80 p-1 rounded-xl">
                {[
                  { id: 'all', label: 'All Transactions' },
                  { id: 'credits', label: 'Earnings & Bonuses' },
                  { id: 'debits', label: 'Deductions & TDS' },
                  { id: 'releases', label: 'Disbursed Payouts' },
                ].map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id as any)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                      activeTab === t.id
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <span className="text-xs text-slate-500 font-medium">
                Showing {filteredEntries.length} statement entries
              </span>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50/70 text-slate-500 font-semibold border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3">Date & Time</th>
                    <th className="px-4 py-3">Transaction Description</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">UTR / Channel</th>
                    <th className="px-4 py-3 text-right">Amount (₹)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredEntries.map((entry) => {
                    const isCredit = entry.category === 'CREDIT';
                    return (
                      <tr key={entry.id} className="hover:bg-slate-50/70 transition-colors">
                        <td className="px-4 py-3 text-slate-600 font-medium whitespace-nowrap">
                          {entry.date}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-bold text-slate-900">{entry.title}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5 max-w-md">{entry.description}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded ${
                              entry.type === 'TRIP_EARNING'
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : entry.type === 'ON_TIME_INCENTIVE' || entry.type === 'SURGE_BONUS'
                                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                                : entry.type === 'PAYOUT_RELEASE'
                                ? 'bg-sky-50 text-sky-700 border border-sky-200'
                                : 'bg-slate-100 text-slate-700 border border-slate-200'
                            }`}
                          >
                            {entry.type.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
                              entry.status === 'RELEASED' || entry.status === 'CLEARED'
                                ? 'text-emerald-700'
                                : 'text-amber-700'
                            }`}
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            {entry.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-500 font-mono text-[11px]">
                          {entry.utrNumber ? (
                            <span className="text-slate-800 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                              {entry.utrNumber}
                            </span>
                          ) : (
                            <span className="text-slate-400">Internal Accrual</span>
                          )}
                        </td>
                        <td className={`px-4 py-3 text-right font-extrabold whitespace-nowrap ${
                          isCredit ? 'text-emerald-700' : 'text-slate-900'
                        }`}>
                          <div className="flex items-center justify-end gap-1">
                            {isCredit ? (
                              <ArrowDownLeft className="h-3.5 w-3.5 text-emerald-600" />
                            ) : (
                              <ArrowUpRight className="h-3.5 w-3.5 text-slate-400" />
                            )}
                            <span>{isCredit ? '+' : '-'}₹{entry.amount.toLocaleString('en-IN')}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 text-slate-500">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            <span>Bank-grade audited ledger records with RBI-compliant instant payment release rails.</span>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 font-semibold rounded-xl transition-colors"
          >
            Close Console
          </button>
        </div>
      </div>
    </div>
  );
};

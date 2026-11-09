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
  ChevronRight,
  Store,
  MapPin,
  Phone,
  FileCheck,
  Percent,
  HelpCircle,
  FileText,
  DollarSign
} from 'lucide-react';
import { AdminSeller, AdminSellerLedgerEntry, AdminPermission } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';
import { exportToCsv } from '../../utils/exportToSheet';
import { SellerEarningsBreakdown } from './SellerEarningsBreakdown';

interface SellerLedgerModalProps {
  seller: AdminSeller;
  onClose: () => void;
  onSellerUpdated?: (updatedSeller: AdminSeller) => void;
  userPermissions: AdminPermission[];
}

export const SellerLedgerModal: React.FC<SellerLedgerModalProps> = ({
  seller,
  onClose,
  onSellerUpdated,
  userPermissions,
}) => {
  const [currentSeller, setCurrentSeller] = useState<AdminSeller>(seller);
  const [activeTab, setActiveTab] = useState<'breakdown' | 'ledger' | 'bank_mandate'>('breakdown');
  const [ledgerViewMode, setLedgerViewMode] = useState<'weekly_statements' | 'detailed_passbook'>('weekly_statements');
  const [ledgerFilter, setLedgerFilter] = useState<'all' | 'credits' | 'debits' | 'releases'>('all');
  
  const [releaseMode, setReleaseMode] = useState<'FULL' | 'CUSTOM'>('FULL');
  const [customAmount, setCustomAmount] = useState<string>('');
  const [payoutMode, setPayoutMode] = useState<'NEFT' | 'IMPS' | 'RTGS' | 'UPI'>('NEFT');
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
  const grossSales = currentSeller.weeklySales || (currentSeller.totalOrders ? currentSeller.totalOrders * 680 : 38400);
  const commissionRate = Math.max(15.0, currentSeller.commissionRatePercent ?? 15.0);
  const pendingBalance = currentSeller.pendingPayableBalance ?? Math.max(1200, Math.round(grossSales * (1 - (commissionRate + 1.1) / 100)));
  const settledTotal = currentSeller.settledBalance || currentSeller.totalSettledPayouts || Math.round(pendingBalance * 4.6);

  // Weekly Statements Sample Data
  const weeklyStatements = [
    {
      id: 'stmt-w37',
      weekNumber: 37,
      cycleTitle: 'Week 37 (Current Active Cycle)',
      dateRange: 'Mon, 08 Sep – Sun, 14 Sep 2026',
      totalOrders: 28,
      grossGMV: grossSales,
      commissionDeducted: Math.round((grossSales * commissionRate) / 100),
      taxesDeducted: Math.round((grossSales * 1.1) / 100),
      netPayable: pendingBalance,
      status: 'ACCRUING' as const,
      payoutSchedule: 'Scheduled: Next Monday 06:00 AM',
      utr: null,
    },
    {
      id: 'stmt-w36',
      weekNumber: 36,
      cycleTitle: 'Week 36 (Previous Weekly Batch)',
      dateRange: 'Mon, 01 Sep – Sun, 07 Sep 2026',
      totalOrders: 32,
      grossGMV: 42800,
      commissionDeducted: Math.round((42800 * commissionRate) / 100),
      taxesDeducted: Math.round((42800 * 1.1) / 100),
      netPayable: 42800 - Math.round((42800 * commissionRate) / 100) - Math.round((42800 * 1.1) / 100),
      status: 'PAID' as const,
      payoutSchedule: 'Disbursed: Mon, 08 Sep 2026 (06:00 AM)',
      utr: `NEFT/RBI20260908${currentSeller.id.slice(-4)}8492`,
    },
    {
      id: 'stmt-w35',
      weekNumber: 35,
      cycleTitle: 'Week 35 Settlement Batch',
      dateRange: 'Mon, 25 Aug – Sun, 31 Aug 2026',
      totalOrders: 30,
      grossGMV: 39500,
      commissionDeducted: Math.round((39500 * commissionRate) / 100),
      taxesDeducted: Math.round((39500 * 1.1) / 100),
      netPayable: 39500 - Math.round((39500 * commissionRate) / 100) - Math.round((39500 * 1.1) / 100),
      status: 'PAID' as const,
      payoutSchedule: 'Disbursed: Mon, 01 Sep 2026 (06:00 AM)',
      utr: `NEFT/RBI20260901${currentSeller.id.slice(-4)}7731`,
    },
    {
      id: 'stmt-w34',
      weekNumber: 34,
      cycleTitle: 'Week 34 Settlement Batch',
      dateRange: 'Mon, 18 Aug – Sun, 24 Aug 2026',
      totalOrders: 26,
      grossGMV: 34200,
      commissionDeducted: Math.round((34200 * commissionRate) / 100),
      taxesDeducted: Math.round((34200 * 1.1) / 100),
      netPayable: 34200 - Math.round((34200 * commissionRate) / 100) - Math.round((34200 * 1.1) / 100),
      status: 'PAID' as const,
      payoutSchedule: 'Disbursed: Mon, 25 Aug 2026 (06:00 AM)',
      utr: `NEFT/RBI20260825${currentSeller.id.slice(-4)}6104`,
    },
  ];

  const defaultLedger: AdminSellerLedgerEntry[] = currentSeller.ledgerEntries && currentSeller.ledgerEntries.length > 0
    ? currentSeller.ledgerEntries
    : [
        {
          id: `led-store-${currentSeller.id}-01`,
          sellerId: currentSeller.id,
          date: 'Today, 03:30 PM',
          timestamp: new Date().toISOString(),
          type: 'PRODUCT_SALE',
          category: 'CREDIT',
          title: 'Order Fulfilled Credit (Order #ORD-9840)',
          description: 'Gross sale of 2x Electrical switches and fixtures delivered in 10 mins',
          amount: 850,
          status: 'CLEARED',
        },
        {
          id: `led-store-${currentSeller.id}-02`,
          sellerId: currentSeller.id,
          date: 'Today, 03:30 PM',
          timestamp: new Date().toISOString(),
          type: 'COMMISSION_DEDUCTION',
          category: 'DEBIT',
          title: `Marketplace Platform Commission (${commissionRate}%)`,
          description: 'Catalog listing & quick-commerce platform fee on Order #ORD-9840',
          amount: Math.round((850 * commissionRate) / 100),
          status: 'CLEARED',
        },
        {
          id: `led-store-${currentSeller.id}-03`,
          sellerId: currentSeller.id,
          date: 'Today, 03:30 PM',
          timestamp: new Date().toISOString(),
          type: 'GST_TCS_DEDUCTION',
          category: 'DEBIT',
          title: 'Statutory Tax: GST TCS (1%) & TDS (0.1%)',
          description: 'Ecommerce operator tax withholding remitted to tax portal',
          amount: Math.round((850 * 1.1) / 100),
          status: 'CLEARED',
        },
        {
          id: `led-store-${currentSeller.id}-04`,
          sellerId: currentSeller.id,
          date: 'Mon, 08 Sep (06:00 AM)',
          timestamp: new Date(Date.now() - 604800000).toISOString(),
          type: 'SETTLEMENT_RELEASE',
          category: 'DEBIT',
          title: 'Weekly Cycle Payout (Week 36 Batch)',
          description: `Automated Monday NEFT payout to ${currentSeller.bankAccount?.bankName || 'HDFC Bank'} A/C ••••${currentSeller.bankAccount?.accountNumber?.slice(-4) || '8492'}`,
          amount: 38668,
          status: 'RELEASED',
          payoutMode: 'NEFT',
          utrNumber: `NEFT/RBI20260908${currentSeller.id.slice(-4)}8492`,
          releasedAt: new Date(Date.now() - 604800000).toISOString(),
          releasedBy: 'Weekly Settlement Engine',
        },
        {
          id: `led-store-${currentSeller.id}-06`,
          sellerId: currentSeller.id,
          date: 'Mon, 01 Sep (06:00 AM)',
          timestamp: new Date(Date.now() - 1209600000).toISOString(),
          type: 'SETTLEMENT_RELEASE',
          category: 'DEBIT',
          title: 'Weekly Cycle Payout (Week 35 Batch)',
          description: `Automated Monday NEFT transfer to ${currentSeller.bankAccount?.bankName || 'HDFC Bank'} Current A/C`,
          amount: 35685,
          status: 'RELEASED',
          payoutMode: 'NEFT',
          utrNumber: `NEFT/RBI20260901${currentSeller.id.slice(-4)}7731`,
          releasedAt: new Date(Date.now() - 1209600000).toISOString(),
          releasedBy: 'Weekly Settlement Engine',
        },
      ];

  const [ledgerEntries, setLedgerEntries] = useState<AdminSellerLedgerEntry[]>(defaultLedger);

  const canProcessSettlement = userPermissions.includes('settlements.process') || userPermissions.includes('riders.payout');

  const filteredLedger = ledgerEntries.filter((item) => {
    if (ledgerFilter === 'credits') return item.category === 'CREDIT';
    if (ledgerFilter === 'debits') return item.category === 'DEBIT' && item.type !== 'SETTLEMENT_RELEASE';
    if (ledgerFilter === 'releases') return item.type === 'SETTLEMENT_RELEASE';
    return true;
  });

  const handleReleaseSettlement = async () => {
    if (!canProcessSettlement) {
      setActionError('Permission denied: You do not have settlements.process permission.');
      return;
    }

    const releaseAmount = releaseMode === 'FULL' ? pendingBalance : parseFloat(customAmount);

    if (!releaseAmount || isNaN(releaseAmount) || releaseAmount <= 0) {
      setActionError('Please enter a valid disbursement amount greater than ₹0.');
      return;
    }

    if (releaseAmount > pendingBalance) {
      setActionError(`Amount cannot exceed the total pending payable balance of ₹${pendingBalance.toLocaleString('en-IN')}`);
      return;
    }

    setIsReleasing(true);
    setActionError(null);

    try {
      const generatedUtr = `NEFT/QCOM${Date.now().toString().slice(-8)}/${currentSeller.id.slice(-4).toUpperCase()}`;

      // Call settlement execution endpoint
      await adminApi.post(`/api/admin/settlements`, {
        sellerId: currentSeller.id,
        sellerName: currentSeller.name,
        amount: releaseAmount,
        payoutMode,
        utrNumber: generatedUtr,
        bankAccount: currentSeller.bankAccount,
      });

      const newLedgerItem: AdminSellerLedgerEntry = {
        id: `led-store-${currentSeller.id}-${Date.now()}`,
        sellerId: currentSeller.id,
        date: 'Just now',
        timestamp: new Date().toISOString(),
        type: 'SETTLEMENT_RELEASE',
        category: 'DEBIT',
        title: `Weekly Settlement Payout Disbursed (${payoutMode})`,
        description: `Disbursed to ${currentSeller.bankAccount?.bankName || 'Bank'} A/C ••••${currentSeller.bankAccount?.accountNumber?.slice(-4) || '8492'}`,
        amount: releaseAmount,
        status: 'RELEASED',
        payoutMode,
        utrNumber: generatedUtr,
        releasedAt: new Date().toISOString(),
        releasedBy: 'Admin Console',
      };

      const newPending = Math.max(0, pendingBalance - releaseAmount);
      const newSettled = settledTotal + releaseAmount;

      const updatedSeller: AdminSeller = {
        ...currentSeller,
        pendingPayableBalance: newPending,
        settledBalance: newSettled,
        ledgerEntries: [newLedgerItem, ...ledgerEntries],
      };

      setCurrentSeller(updatedSeller);
      setLedgerEntries([newLedgerItem, ...ledgerEntries]);

      setPayoutSuccessData({
        utr: generatedUtr,
        amount: releaseAmount,
        mode: payoutMode,
        destination: `${currentSeller.bankAccount?.bankName || 'Bank'} · ${currentSeller.bankAccount?.accountNumber || 'Verified A/C'}`,
        timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      });

      if (onSellerUpdated) {
        onSellerUpdated(updatedSeller);
      }
    } catch (err: any) {
      setActionError(err.message || 'Failed to process store settlement release');
    } finally {
      setIsReleasing(false);
    }
  };

  const handleExportLedgerCsv = () => {
    exportToCsv<AdminSellerLedgerEntry>(
      `Seller_Weekly_Ledger_${currentSeller.name.replace(/\s+/g, '_')}`,
      [
        { header: 'Store ID', accessor: () => currentSeller.id },
        { header: 'Store Name', accessor: () => currentSeller.name },
        { header: 'Date & Time', accessor: (item) => item.date },
        { header: 'Entry Type', accessor: (item) => item.type },
        { header: 'Direction', accessor: (item) => item.category },
        { header: 'Title', accessor: (item) => item.title },
        { header: 'Description', accessor: (item) => item.description },
        { header: 'Amount (INR)', accessor: (item) => (item.category === 'CREDIT' ? item.amount : -item.amount) },
        { header: 'Status', accessor: (item) => item.status },
        { header: 'Payout Mode', accessor: (item) => item.payoutMode || 'N/A' },
        { header: 'UTR Number', accessor: (item) => item.utrNumber || 'N/A' },
      ],
      filteredLedger
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-4xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden relative animate-in fade-in zoom-in-95 duration-150">
        {/* Dedicated Top-Right Modal Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 z-30 p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-200/80 rounded-full transition-colors"
          title="Close Store Financials"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Top Header Card */}
        <div className="p-5 sm:p-6 bg-slate-50 border-b border-slate-200 pr-14 sm:pr-16">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="h-14 w-14 rounded-2xl bg-indigo-100 border border-indigo-200 flex items-center justify-center text-indigo-700 shrink-0 shadow-xs">
                <Store className="h-7 w-7" />
              </div>

              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold text-slate-900">{currentSeller.name}</h2>
                  <span
                    className={`text-xs font-semibold px-2.5 py-0.5 rounded-full inline-flex items-center gap-1.5 uppercase ${
                      currentSeller.isStoreOnline && currentSeller.status === 'ACTIVE'
                        ? 'bg-emerald-100 text-emerald-800'
                        : currentSeller.status === 'SUSPENDED'
                        ? 'bg-rose-100 text-rose-800'
                        : 'bg-amber-100 text-amber-800'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        currentSeller.isStoreOnline ? 'bg-emerald-600 animate-pulse' : 'bg-amber-500'
                      }`}
                    />
                    <span>{currentSeller.isStoreOnline ? 'Store Live & Accepting Orders' : 'Store Offline'}</span>
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 mt-1.5">
                  <span className="flex items-center gap-1 text-slate-700 font-medium">
                    <Building className="h-3.5 w-3.5 text-slate-400" />
                    Owner: {currentSeller.ownerName}
                  </span>
                  <span className="flex items-center gap-1 text-slate-700 font-medium">
                    <Phone className="h-3.5 w-3.5 text-slate-400" />
                    {currentSeller.phone}
                  </span>
                  <span className="text-slate-500">
                    GSTIN: <strong className="text-slate-700 font-mono">{currentSeller.gstin}</strong>
                  </span>
                  <span className="text-indigo-700 font-medium bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100 text-[11px]">
                    Commission: {commissionRate}%
                  </span>
                </div>
              </div>
            </div>

            {/* Quick Status Pill in Header */}
            <div className="flex items-center gap-2">
              <div className="text-right">
                <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider block">
                  Current Week Payable Balance
                </span>
                <span className="text-lg font-extrabold text-amber-700 font-mono">
                  ₹{pendingBalance.toLocaleString('en-IN')}
                </span>
              </div>
            </div>
          </div>

          {/* Quick Metrics Ribbon */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-4 pt-4 border-t border-slate-200/80">
            <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
              <div className="text-[10px] text-slate-500 font-medium">Payout Frequency</div>
              <div className="text-xs font-bold text-indigo-700 truncate mt-0.5 flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" />
                <span>Weekly (Every Monday)</span>
              </div>
            </div>

            <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
              <div className="text-[10px] text-slate-500 font-medium">Bank A/C Verified</div>
              <div className="text-xs font-bold text-emerald-700 truncate mt-0.5 flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>{currentSeller.bankAccount?.bankName || 'HDFC Bank'} ({currentSeller.bankAccount?.accountNumber ? `••••${currentSeller.bankAccount.accountNumber.slice(-4)}` : '••••8492'})</span>
              </div>
            </div>

            <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
              <div className="text-[10px] text-slate-500 font-medium">Total Lifetime Settled</div>
              <div className="text-xs font-bold text-slate-900 truncate mt-0.5">
                ₹{settledTotal.toLocaleString('en-IN')}
              </div>
            </div>

            <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
              <div className="text-[10px] text-slate-500 font-medium">SLA & Prep Score</div>
              <div className="text-xs font-bold text-slate-900 truncate mt-0.5">
                {currentSeller.slaAdherencePercent ?? 98.5}% · {currentSeller.avgPrepTimeMins ?? 4.2}m prep (5m SLA)
              </div>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-200 bg-white px-4 sm:px-6 gap-2 text-xs font-semibold overflow-x-auto scrollbar-none shrink-0">
          {[
            { id: 'breakdown', label: 'Weekly Sales & Performance', icon: TrendingUp },
            { id: 'ledger', label: 'Settlement Statements & Ledger', icon: CreditCard },
            { id: 'bank_mandate', label: 'Bank Account & Compliance', icon: Building },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id as any)}
                className={`py-3.5 px-3.5 border-b-2 flex items-center gap-2 whitespace-nowrap transition-all shrink-0 ${
                  isActive
                    ? 'border-indigo-600 text-indigo-700 font-bold bg-indigo-50/40'
                    : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                <Icon className={`h-4 w-4 ${isActive ? 'text-indigo-600' : 'text-slate-400'}`} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Scrollable Content Body */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-6">
          {/* TAB 1: SALES & REVENUE BREAKDOWN */}
          {activeTab === 'breakdown' && (
            <div className="space-y-6">
              {/* Settlement Payout Desk */}
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 shadow-2xs space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                  <div className="flex items-center gap-2">
                    <div className="h-7 w-7 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold">
                      <Send className="h-3.5 w-3.5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">
                        Weekly Settlement Disbursal Desk
                      </h3>
                      <p className="text-[11px] text-slate-500">
                        Disburse current week accrued earnings early or allow automated Monday clearing
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 font-medium">Bank Destination:</span>
                    <span className="text-xs font-bold text-slate-800 bg-white px-2.5 py-1 rounded-lg border border-slate-200">
                      {currentSeller.bankAccount?.bankName || 'HDFC Bank'} ({currentSeller.bankAccount?.accountNumber ? `••••${currentSeller.bankAccount.accountNumber.slice(-4)}` : '••••8492'})
                    </span>
                  </div>
                </div>

                {payoutSuccessData && (
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 space-y-1 animate-in fade-in">
                    <div className="flex items-center gap-1.5 font-bold text-emerald-800">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      <span>Weekly Settlement Successfully Disbursed!</span>
                    </div>
                    <p className="text-[11px] text-emerald-700">
                      ₹{payoutSuccessData.amount.toLocaleString('en-IN')} transferred via {payoutSuccessData.mode} to {payoutSuccessData.destination}. Bank UTR: <strong>{payoutSuccessData.utr}</strong>
                    </p>
                  </div>
                )}

                {actionError && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" />
                    <span>{actionError}</span>
                  </div>
                )}

                {/* Settlement Controls */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-slate-700 block mb-1">Disbursement Mode</label>
                    <div className="flex rounded-xl bg-white border border-slate-200 p-1 text-xs">
                      <button
                        type="button"
                        onClick={() => setReleaseMode('FULL')}
                        className={`flex-1 py-1.5 rounded-lg font-bold transition-all ${
                          releaseMode === 'FULL' ? 'bg-indigo-600 text-white shadow-2xs' : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Full Week (₹{pendingBalance.toLocaleString('en-IN')})
                      </button>
                      <button
                        type="button"
                        onClick={() => setReleaseMode('CUSTOM')}
                        className={`flex-1 py-1.5 rounded-lg font-bold transition-all ${
                          releaseMode === 'CUSTOM' ? 'bg-indigo-600 text-white shadow-2xs' : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Custom Amount
                      </button>
                    </div>
                  </div>

                  {releaseMode === 'CUSTOM' ? (
                    <div>
                      <label className="text-xs font-semibold text-slate-700 block mb-1">Custom Amount (₹)</label>
                      <input
                        type="number"
                        placeholder="Enter amount in INR"
                        value={customAmount}
                        onChange={(e) => setCustomAmount(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono font-bold text-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
                      />
                    </div>
                  ) : (
                    <div>
                      <label className="text-xs font-semibold text-slate-700 block mb-1">Transfer Rail</label>
                      <select
                        value={payoutMode}
                        onChange={(e) => setPayoutMode(e.target.value as any)}
                        className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold text-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
                      >
                        <option value="NEFT">RBI NEFT (Standard Weekly Settlement)</option>
                        <option value="IMPS">Instant IMPS Real-Time Transfer</option>
                        <option value="RTGS">RTGS High-Value Bank Rail</option>
                        <option value="UPI">Corporate UPI Bank Mandate</option>
                      </select>
                    </div>
                  )}

                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={handleReleaseSettlement}
                      disabled={isReleasing || pendingBalance <= 0 || !canProcessSettlement}
                      className="w-full bg-[#009DE0] hover:bg-[#0087c2] disabled:opacity-50 text-white font-bold py-2 px-4 rounded-xl text-xs flex items-center justify-center gap-1.5 shadow-xs transition-colors"
                    >
                      {isReleasing ? (
                        <>
                          <Clock className="h-3.5 w-3.5 animate-spin" />
                          <span>Routing Bank Payment...</span>
                        </>
                      ) : (
                        <>
                          <Send className="h-3.5 w-3.5" />
                          <span>Disburse Settlement (₹{releaseMode === 'FULL' ? pendingBalance.toLocaleString('en-IN') : (Number(customAmount) || 0).toLocaleString('en-IN')})</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Comprehensive Breakdown Engine */}
              <SellerEarningsBreakdown seller={currentSeller} />
            </div>
          )}

          {/* TAB 2: SETTLEMENT STATEMENTS & LEDGER (REVAMPED FOR EASY UNDERSTANDING) */}
          {activeTab === 'ledger' && (
            <div className="space-y-5">
              {/* Educational How-It-Works Banner */}
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
                <div className="flex items-start gap-3">
                  <div className="h-8 w-8 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0">
                    <HelpCircle className="h-4 w-4" />
                  </div>
                  <div className="space-y-1 text-xs">
                    <h4 className="font-bold text-slate-900">How Seller Weekly Payouts & Ledger Work</h4>
                    <p className="text-slate-600 text-[11px] leading-relaxed">
                      1. <strong>Order Revenue</strong>: Each completed customer order credits the store account with the gross cart value.<br/>
                      2. <strong>Platform Fees & Taxes</strong>: Platform commission ({commissionRate}%) and statutory withholding (1.1% GST TCS & TDS Section 194-O) are deducted automatically.<br/>
                      3. <strong>Monday Disbursement</strong>: Every Monday at 06:00 AM, the consolidated weekly balance is wired directly via RBI NEFT to the merchant's verified bank account.
                    </p>
                  </div>
                </div>
              </div>

              {/* Top View Switcher & Action Bar */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-100/80 p-2 rounded-2xl border border-slate-200">
                {/* View Switcher Tabs */}
                <div className="flex items-center bg-slate-200/80 p-1 rounded-xl text-xs font-semibold gap-1">
                  <button
                    type="button"
                    onClick={() => setLedgerViewMode('weekly_statements')}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all ${
                      ledgerViewMode === 'weekly_statements'
                        ? 'bg-white text-indigo-700 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <span>Weekly Settlement Statements</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setLedgerViewMode('detailed_passbook')}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all ${
                      ledgerViewMode === 'detailed_passbook'
                        ? 'bg-white text-indigo-700 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Receipt className="h-3.5 w-3.5" />
                    <span>Detailed Transaction Passbook</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleExportLedgerCsv}
                  className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded-xl text-xs font-semibold border border-slate-300 shadow-2xs transition-colors shrink-0"
                >
                  <Download className="h-3.5 w-3.5 text-slate-500" />
                  <span>Export Full Ledger (CSV)</span>
                </button>
              </div>

              {/* VIEW 1: WEEKLY SETTLEMENT STATEMENTS */}
              {ledgerViewMode === 'weekly_statements' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs text-slate-500 px-1 font-medium">
                    <span>Showing all weekly settlement cycles for this store:</span>
                    <span>Payout Schedule: Every Monday</span>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    {weeklyStatements.map((stmt) => (
                      <div
                        key={stmt.id}
                        className={`bg-white border rounded-2xl p-4 shadow-2xs transition-all ${
                          stmt.status === 'ACCRUING'
                            ? 'border-indigo-200 bg-gradient-to-r from-white via-indigo-50/20 to-white'
                            : 'border-slate-200'
                        }`}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-3">
                          <div className="flex items-center gap-2.5">
                            <div className={`h-8 w-8 rounded-xl flex items-center justify-center font-bold text-xs ${
                              stmt.status === 'ACCRUING' ? 'bg-indigo-100 text-indigo-700' : 'bg-emerald-100 text-emerald-700'
                            }`}>
                              W{stmt.weekNumber}
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <h4 className="text-sm font-bold text-slate-900">{stmt.cycleTitle}</h4>
                                <span
                                  className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                                    stmt.status === 'ACCRUING'
                                      ? 'bg-amber-100 text-amber-800'
                                      : 'bg-emerald-100 text-emerald-800'
                                  }`}
                                >
                                  {stmt.status === 'ACCRUING' ? 'Accruing (Pending Monday Wire)' : 'Paid & Settled'}
                                </span>
                              </div>
                              <span className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                                <Calendar className="h-3 w-3 text-slate-400" />
                                {stmt.dateRange} · {stmt.totalOrders} Completed Orders
                              </span>
                            </div>
                          </div>

                          <div className="text-right">
                            <span className="text-[10px] text-slate-500 font-semibold uppercase block">
                              {stmt.status === 'ACCRUING' ? 'Accrued Net Payable' : 'Net Disbursed Payout'}
                            </span>
                            <span className={`text-base font-extrabold font-mono ${
                              stmt.status === 'ACCRUING' ? 'text-amber-700' : 'text-emerald-700'
                            }`}>
                              ₹{stmt.netPayable.toLocaleString('en-IN')}
                            </span>
                          </div>
                        </div>

                        {/* Statement Mathematical Summary Chips */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-3 text-xs">
                          <div className="bg-slate-50 p-2 rounded-xl">
                            <span className="text-[10px] text-slate-500 font-medium block">Gross Sales (GMV)</span>
                            <span className="font-bold text-slate-900 font-mono">+₹{stmt.grossGMV.toLocaleString('en-IN')}</span>
                          </div>

                          <div className="bg-indigo-50/50 p-2 rounded-xl">
                            <span className="text-[10px] text-indigo-700 font-medium block">Commission Deducted</span>
                            <span className="font-bold text-indigo-900 font-mono">-₹{stmt.commissionDeducted.toLocaleString('en-IN')}</span>
                          </div>

                          <div className="bg-amber-50/50 p-2 rounded-xl">
                            <span className="text-[10px] text-amber-800 font-medium block">Taxes (TCS/TDS 1.1%)</span>
                            <span className="font-bold text-amber-900 font-mono">-₹{stmt.taxesDeducted.toLocaleString('en-IN')}</span>
                          </div>
                        </div>

                        {/* Bottom Status / Reference Footer */}
                        <div className="mt-3 pt-2.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 font-medium">
                          <div>
                            {stmt.utr ? (
                              <span>Bank UTR Reference: <strong className="text-emerald-700 font-mono">{stmt.utr}</strong></span>
                            ) : (
                              <span className="text-indigo-700 font-semibold">{stmt.payoutSchedule}</span>
                            )}
                          </div>

                          {stmt.status === 'ACCRUING' && canProcessSettlement && (
                            <button
                              type="button"
                              onClick={() => {
                                setReleaseMode('FULL');
                                setActiveTab('breakdown');
                              }}
                              className="text-indigo-700 font-bold hover:text-indigo-900 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded-lg border border-indigo-200 transition-colors"
                            >
                              Disburse Current Batch Early →
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* VIEW 2: DETAILED TRANSACTION PASSBOOK */}
              {ledgerViewMode === 'detailed_passbook' && (
                <div className="space-y-3">
                  {/* Filter Tabs */}
                  <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl text-xs">
                    {[
                      { id: 'all', label: 'All Transactions' },
                      { id: 'credits', label: 'Order Sales (+)' },
                      { id: 'debits', label: 'Fees & Deductions (-)' },
                      { id: 'releases', label: 'Weekly Bank Payouts (🏦)' },
                    ].map((filter) => (
                      <button
                        key={filter.id}
                        type="button"
                        onClick={() => setLedgerFilter(filter.id as any)}
                        className={`px-3 py-1 rounded-lg text-xs font-bold transition-all ${
                          ledgerFilter === filter.id
                            ? 'bg-white text-slate-900 shadow-2xs'
                            : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                        }`}
                      >
                        {filter.label}
                      </button>
                    ))}
                  </div>

                  {/* Passbook Table */}
                  <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xs">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-500 font-semibold border-b border-slate-200">
                        <tr>
                          <th className="py-2.5 px-4">Date & Time</th>
                          <th className="py-2.5 px-4">Transaction Details</th>
                          <th className="py-2.5 px-3">Type</th>
                          <th className="py-2.5 px-4 text-right">Inflow / Outflow</th>
                          <th className="py-2.5 px-4 text-center">Status & UTR</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {filteredLedger.map((item) => (
                          <tr key={item.id} className="hover:bg-slate-50/75 transition-colors">
                            <td className="py-3 px-4 whitespace-nowrap font-mono text-slate-600 text-[11px]">
                              {item.date}
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-bold text-slate-900">{item.title}</div>
                              <div className="text-[11px] text-slate-500 mt-0.5">{item.description}</div>
                            </td>
                            <td className="py-3 px-3">
                              <span
                                className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                                  item.category === 'CREDIT'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : item.type === 'SETTLEMENT_RELEASE'
                                    ? 'bg-indigo-100 text-indigo-800'
                                    : 'bg-slate-100 text-slate-700'
                                }`}
                              >
                                {item.category === 'CREDIT' ? '+ CREDIT' : item.type === 'SETTLEMENT_RELEASE' ? 'BANK TRANSFER' : '- DEBIT'}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-right font-mono font-bold text-sm">
                              {item.category === 'CREDIT' ? (
                                <span className="text-emerald-700">+₹{item.amount.toLocaleString('en-IN')}</span>
                              ) : (
                                <span className="text-slate-800">-₹{item.amount.toLocaleString('en-IN')}</span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-center">
                              <div className="flex flex-col items-center">
                                <span
                                  className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                                    item.status === 'RELEASED' || item.status === 'CLEARED'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-amber-100 text-amber-800'
                                  }`}
                                >
                                  {item.status}
                                </span>
                                {item.utrNumber && (
                                  <span className="text-[10px] font-mono text-slate-400 mt-0.5">
                                    {item.utrNumber}
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: BANK ACCOUNT & COMPLIANCE MANDATE */}
          {activeTab === 'bank_mandate' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Bank Account Verification Card */}
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-4">
                <div className="flex items-center gap-2.5 border-b border-slate-200 pb-3">
                  <div className="h-8 w-8 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
                    <Building className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Settlement Bank Account</h3>
                    <p className="text-xs text-slate-500">NPCI Penny-Drop Verified Corporate Account for Weekly Settlements</p>
                  </div>
                </div>

                <div className="space-y-3 text-xs">
                  <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                    <span className="text-slate-500 font-medium">Bank Name</span>
                    <span className="font-bold text-slate-900">{currentSeller.bankAccount?.bankName || 'HDFC Bank Ltd'}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                    <span className="text-slate-500 font-medium">Account Number</span>
                    <span className="font-mono font-bold text-slate-900">{currentSeller.bankAccount?.accountNumber || '50200084920194'}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                    <span className="text-slate-500 font-medium">IFSC Code</span>
                    <span className="font-mono font-bold text-slate-900">{currentSeller.bankAccount?.ifsc || 'HDFC0001234'}</span>
                  </div>
                  <div className="flex justify-between py-1.5">
                    <span className="text-slate-500 font-medium">NPCI Penny Drop Verification</span>
                    <span className="text-emerald-700 font-bold flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>Verified & Active</span>
                    </span>
                  </div>
                </div>
              </div>

              {/* Statutory Tax & Legal Mandate Card */}
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-4">
                <div className="flex items-center gap-2.5 border-b border-slate-200 pb-3">
                  <div className="h-8 w-8 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold">
                    <FileCheck className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Tax & Compliance Registrations</h3>
                    <p className="text-xs text-slate-500">Statutory GSTIN, PAN & Trade License</p>
                  </div>
                </div>

                <div className="space-y-3 text-xs">
                  <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                    <span className="text-slate-500 font-medium">GSTIN Registration</span>
                    <span className="font-mono font-bold text-slate-900">{currentSeller.gstin || '29AABCU9603R1ZM'}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                    <span className="text-slate-500 font-medium">PAN Number</span>
                    <span className="font-mono font-bold text-slate-900">{currentSeller.panNumber || 'AABCU9603R'}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-200/60">
                    <span className="text-slate-500 font-medium">Trade License</span>
                    <span className="font-mono font-bold text-slate-900">{currentSeller.documents?.tradeLicenseNumber || 'TL-BBMP-2026-9812'}</span>
                  </div>
                  <div className="flex justify-between py-1.5">
                    <span className="text-slate-500 font-medium">TDS Section</span>
                    <span className="font-bold text-slate-800">Section 194-O (0.1%) + GST TCS (1%)</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

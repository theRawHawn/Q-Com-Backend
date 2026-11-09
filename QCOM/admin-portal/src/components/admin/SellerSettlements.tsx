import React, { useState, useEffect } from 'react';
import {
  Receipt,
  CheckCircle2,
  Clock,
  Building,
  RefreshCw,
  FileSpreadsheet,
  ShieldCheck,
  Send,
  Search,
  CreditCard,
  TrendingUp
} from 'lucide-react';
import { AdminSettlement, AdminPermission, AdminSeller } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';
import { SellerLedgerModal } from './SellerLedgerModal';

interface SellerSettlementsProps {
  userPermissions: AdminPermission[];
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
}

export const SellerSettlements: React.FC<SellerSettlementsProps> = ({
  userPermissions,
  searchQuery: externalSearchQuery,
  onSearchQueryChange,
}) => {
  const [settlements, setSettlements] = useState<AdminSettlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState(externalSearchQuery || '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedSellerForLedger, setSelectedSellerForLedger] = useState<AdminSeller | null>(null);

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

  const canProcessSettlement = userPermissions.includes('settlements.process');

  const fetchSettlements = async () => {
    try {
      setLoading(true);
      const res: any = await adminApi.get('/api/admin/settlements');
      if (res.success) setSettlements(res.settlements);
    } catch (err) {
      console.error('Failed to load settlements:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettlements();
  }, []);

  const queryLower = searchQuery.toLowerCase();
  const filteredSettlements = settlements.filter(
    (s) =>
      !queryLower ||
      s.sellerName.toLowerCase().includes(queryLower) ||
      s.id.toLowerCase().includes(queryLower) ||
      s.status.toLowerCase().includes(queryLower) ||
      (s.utrNumber && s.utrNumber.toLowerCase().includes(queryLower))
  );

  const handleProcessSettlement = async (settlementId: string) => {
    if (!canProcessSettlement) return;
    try {
      setIsSubmitting(true);
      await adminApi.post(`/api/admin/settlements/${settlementId}/process`, {});
      fetchSettlements();
    } catch (err: any) {
      alert(err.message || 'Settlement execution failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Seller Weekly Settlements
          </h1>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search store name, UTR, status..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full bg-slate-50/80 border border-slate-200/80 rounded-md pl-9 pr-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#009DE0]/20 focus:border-[#009DE0] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
            />
          </div>

          <button
            onClick={fetchSettlements}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200/90 transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)] shrink-0 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#009DE0]' : 'text-slate-500'}`} />
            <span>Sync Batches</span>
          </button>
        </div>
      </div>

      {/* Settlement Cards / Tables */}
      <div className="space-y-4">
        {filteredSettlements.map((set) => (
          <div
            key={set.id}
            className="bg-white border border-slate-200 rounded-2xl p-6 shadow-2xs space-y-4 hover:border-slate-300 transition-all"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-3">
              <div>
                <h3 className="font-bold text-slate-900 text-base">{set.sellerName}</h3>
                <p className="text-xs text-slate-500 mt-0.5 font-mono">
                  Cycle: {set.periodStart} → {set.periodEnd} (ID: {set.id})
                </p>
              </div>

              <div className="flex items-center gap-3">
                <span
                  className={`px-3 py-1 rounded-lg text-xs font-mono font-bold uppercase ${
                    set.status === 'PAID'
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : set.status === 'PROCESSED'
                      ? 'bg-sky-50 text-sky-700 border border-sky-200'
                      : 'bg-amber-50 text-amber-700 border border-amber-200'
                  }`}
                >
                  {set.status}
                </span>

                {set.status !== 'PAID' && (
                  <button
                    onClick={() => handleProcessSettlement(set.id)}
                    disabled={!canProcessSettlement || isSubmitting}
                    className="bg-[#009DE0] hover:bg-[#0087c2] disabled:opacity-50 text-white font-bold px-4 py-1.5 rounded-xl text-xs flex items-center gap-1.5 transition-all shadow-xs"
                  >
                    <Send className="h-3.5 w-3.5" />
                    <span>Disburse NEFT Batch</span>
                  </button>
                )}
              </div>
            </div>

            {/* Reconciliation Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 bg-slate-50 p-4 rounded-xl border border-slate-200 font-mono text-xs">
              <div>
                <span className="text-slate-500 text-[10px] block">Gross GMV Sales</span>
                <span className="text-slate-900 font-bold text-sm">₹{set.grossSales.toLocaleString('en-IN')}</span>
              </div>
              <div>
                <span className="text-slate-500 text-[10px] block">QCOM Commission (–)</span>
                <span className="text-rose-600 font-semibold">₹{set.commissionDeducted.toLocaleString('en-IN')}</span>
              </div>
              <div>
                <span className="text-slate-500 text-[10px] block">Refunds Adjusted (–)</span>
                <span className="text-rose-600 font-semibold">₹{set.refundsAdjusted.toLocaleString('en-IN')}</span>
              </div>
              <div>
                <span className="text-slate-500 text-[10px] block">1% Sec 194O TDS (–)</span>
                <span className="text-amber-700 font-semibold">₹{set.tdsDeducted.toLocaleString('en-IN')}</span>
              </div>
              <div className="col-span-2 sm:col-span-1 bg-white p-2 rounded-lg border border-slate-300 shadow-2xs">
                <span className="text-slate-500 text-[10px] block">Net Seller Payable</span>
                <span className="text-emerald-700 font-bold font-mono text-sm">₹{set.netPayable.toLocaleString('en-IN')}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 text-xs">
              <div className="text-[11px] font-mono text-slate-500">
                {set.utrNumber ? (
                  <span>Bank Disbursal UTR: <strong className="text-emerald-700">{set.utrNumber}</strong> · {set.payoutDate}</span>
                ) : (
                  <span>Awaiting automated clearance batch</span>
                )}
              </div>

              <button
                type="button"
                onClick={() =>
                  setSelectedSellerForLedger({
                    id: set.sellerId,
                    name: set.sellerName,
                    ownerName: 'Store Manager',
                    hubType: 'Partner Store Hub',
                    phone: '+91 98450 12345',
                    email: 'store@qcommerce.com',
                    address: 'Fulfillment Cluster, Bangalore',
                    areaName: 'Koramangala 4th Block',
                    gstin: '29AABCU9603R1ZM',
                    panNumber: 'AABCU9603R',
                    bankAccount: {
                      accountNumber: '50200084920194',
                      ifsc: 'HDFC0001234',
                      bankName: 'HDFC Bank Ltd',
                    },
                    status: 'ACTIVE',
                    isStoreOnline: true,
                    canReceiveOrders: true,
                    isOrderingEnabled: true,
                    commissionRatePercent: 15.0,
                    rating: 4.8,
                    totalOrders: 280,
                    activeOrdersCount: 6,
                    avgPrepTimeMins: 4.2,
                    slaAdherencePercent: 98.5,
                    joinedDate: 'Nov 2025',
                    documents: {
                      gstVerified: true,
                      panVerified: true,
                      bankVerified: true,
                      tradeLicenseVerified: true,
                    },
                    todaySales: set.grossSales,
                    pendingPayableBalance: set.status === 'PAID' ? 0 : set.netPayable,
                    settledBalance: set.status === 'PAID' ? set.netPayable : 42000,
                  })
                }
                className="flex items-center gap-1 text-indigo-700 font-semibold hover:text-indigo-900 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded-lg border border-indigo-200 transition-colors"
              >
                <TrendingUp className="h-3.5 w-3.5" />
                <span>View Full Store Sales Dashboard</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Seller Sales & Ledger Modal */}
      {selectedSellerForLedger && (
        <SellerLedgerModal
          seller={selectedSellerForLedger}
          onClose={() => setSelectedSellerForLedger(null)}
          onSellerUpdated={() => fetchSettlements()}
          userPermissions={userPermissions}
        />
      )}
    </div>
  );
};

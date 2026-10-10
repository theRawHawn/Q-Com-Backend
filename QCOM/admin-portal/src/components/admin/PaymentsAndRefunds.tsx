import React, { useState, useEffect } from 'react';
import {
  CreditCard,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Search,
  ShieldCheck,
  ArrowUpRight,
  ArrowDownLeft,
  TrendingUp,
  Download,
  Plus,
  Eye,
  SlidersHorizontal,
  Ban,
  Clock,
  LayoutGrid,
  List,
  CheckSquare,
  Square,
  Building2,
  FileCheck,
  Scale,
  Zap,
  ChevronRight,
  ChevronDown,
  PauseCircle,
  Sliders
} from 'lucide-react';
import { AdminRefund, AdminOrder, AdminPermission, AdminRefundDispute, RefundPolicyConfig } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';
import { exportToCsv } from '../../utils/exportToSheet';
import { CreateRefundModal } from './CreateRefundModal';
import { RefundDetailModal } from './RefundDetailModal';
import { RefundActionModal } from './RefundActionModal';
import { DisputeResolutionModal } from './DisputeResolutionModal';
import { RefundPolicyModal } from './RefundPolicyModal';
import { RefundEditModal } from './RefundEditModal';

interface PaymentsAndRefundsProps {
  userPermissions: AdminPermission[];
  selectedCity?: string;
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
}

export const PaymentsAndRefunds: React.FC<PaymentsAndRefundsProps> = ({
  userPermissions,
  selectedCity = 'all',
  searchQuery: externalSearchQuery,
  onSearchQueryChange,
}) => {
  const [activeTab, setActiveTab] = useState<'REFUNDS' | 'DISPUTES'>('REFUNDS');
  const [refunds, setRefunds] = useState<AdminRefund[]>([]);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [disputes, setDisputes] = useState<AdminRefundDispute[]>([]);
  const [policy, setPolicy] = useState<RefundPolicyConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'table' | 'grid'>('table');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [channelFilter, setChannelFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState(externalSearchQuery || '');
  const [activeOptionsId, setActiveOptionsId] = useState<string | null>(null);

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
  const [selectedRefundIds, setSelectedRefundIds] = useState<string[]>([]);
  const [actionAlert, setActionAlert] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedRefundForDetail, setSelectedRefundForDetail] = useState<AdminRefund | null>(null);
  const [editingRefund, setEditingRefund] = useState<AdminRefund | null>(null);
  const [actionModalConfig, setActionModalConfig] = useState<{ refund: AdminRefund; type: 'APPROVE' | 'REJECT' | 'HOLD' | 'RETRY' } | null>(null);
  const [selectedDispute, setSelectedDispute] = useState<AdminRefundDispute | null>(null);
  const [showPolicyModal, setShowPolicyModal] = useState(false);
  const [isReconciling, setIsReconciling] = useState(false);

  // Permissions
  const canCreateRefund = userPermissions.includes('refunds.create') || userPermissions.includes('payments.refund');
  const canApproveRefund = userPermissions.includes('refunds.approve') || userPermissions.includes('payments.approve_refund');
  const canExport = userPermissions.includes('payments.export');

  const showAlert = (text: string, type: 'success' | 'error' = 'success') => {
    setActionAlert({ text, type });
    setTimeout(() => setActionAlert(null), 4000);
  };

  const fetchData = async () => {
    try {
      setLoading(true);
      const [refRes, ordRes]: [any, any] = await Promise.all([
        adminApi.get('/api/admin/refunds'),
        adminApi.get('/api/admin/orders'),
      ]);

      if (refRes && refRes.success) {
        setRefunds(refRes.refunds || []);
        if (refRes.disputes) setDisputes(refRes.disputes);
        if (refRes.policy) setPolicy(refRes.policy);
      }
      if (ordRes && ordRes.success) {
        setOrders(ordRes.orders || []);
      }
    } catch (err) {
      console.error('Failed to load financial records:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    const handleDocumentClick = () => {
      setActiveOptionsId(null);
    };
    document.addEventListener('click', handleDocumentClick);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  }, []);

  // Status transition handler for individual refund
  const handleStatusChange = async (
    refund: AdminRefund,
    newStatus: 'PENDING' | 'APPROVED' | 'COMPLETED' | 'REJECTED' | 'ON_HOLD'
  ) => {
    setActiveOptionsId(null);
    if (!canApproveRefund) {
      showAlert('You do not have permission to modify refund status.', 'error');
      return;
    }

    // Modal flows for actions that take notes/reasons/gateway configs
    if (newStatus === 'APPROVED') {
      setActionModalConfig({ refund, type: 'APPROVE' });
      return;
    }
    if (newStatus === 'REJECTED') {
      setActionModalConfig({ refund, type: 'REJECT' });
      return;
    }
    if (newStatus === 'ON_HOLD') {
      setActionModalConfig({ refund, type: 'HOLD' });
      return;
    }

    // Direct update for PENDING or COMPLETED / REFUNDED
    try {
      setLoading(true);
      const generatedUtr = newStatus === 'COMPLETED' 
        ? (refund.bankUtr || `REF-UPI-${Date.now().toString().slice(-8)}`)
        : refund.bankUtr;

      const res: any = await adminApi.put(`/api/admin/refunds/${refund.id}`, {
        status: newStatus,
        bankUtr: generatedUtr,
        adminNotes: `Status changed to ${newStatus} by admin supervisor.`,
      });

      if (res && res.success) {
        showAlert(res.message || `Refund #${refund.orderNumber} updated to ${newStatus}.`);
        fetchData();
      } else {
        showAlert(res?.message || 'Status update failed.', 'error');
      }
    } catch (err: any) {
      showAlert(err.message || 'Failed to update refund status.', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Filtered Refunds
  const filteredRefunds = refunds.filter((r) => {
    const matchesStatus = statusFilter === 'ALL' || r.status === statusFilter;
    const matchesChannel = channelFilter === 'ALL' || (r.channel || 'UPI_INSTANT') === channelFilter;
    const matchesCity =
      !selectedCity || selectedCity === 'all' || (r.cityName || '').toLowerCase() === selectedCity.toLowerCase();
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      !q ||
      r.orderNumber.toLowerCase().includes(q) ||
      r.customerName.toLowerCase().includes(q) ||
      (r.customerPhone && r.customerPhone.includes(q)) ||
      (r.reason && r.reason.toLowerCase().includes(q)) ||
      (r.bankUtr && r.bankUtr.toLowerCase().includes(q)) ||
      (r.transactionId && r.transactionId.toLowerCase().includes(q));

    return matchesStatus && matchesChannel && matchesCity && matchesSearch;
  });

  // Filtered Disputes
  const filteredDisputes = disputes.filter((d) => {
    const q = searchQuery.toLowerCase();
    return (
      !q ||
      d.orderNumber.toLowerCase().includes(q) ||
      d.customerName.toLowerCase().includes(q) ||
      d.claimReference.toLowerCase().includes(q) ||
      d.bankName.toLowerCase().includes(q)
    );
  });

  // Bulk Operations
  const handleSelectAll = () => {
    if (selectedRefundIds.length === filteredRefunds.length) {
      setSelectedRefundIds([]);
    } else {
      setSelectedRefundIds(filteredRefunds.map((r) => r.id));
    }
  };

  const handleToggleSelect = (id: string) => {
    setSelectedRefundIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleBulkStatusChange = async (targetStatus: 'APPROVED' | 'PENDING' | 'ON_HOLD' | 'REJECTED' | 'COMPLETED') => {
    if (!canApproveRefund || selectedRefundIds.length === 0) return;
    try {
      setLoading(true);
      if (targetStatus === 'APPROVED') {
        const res: any = await adminApi.post('/api/admin/refunds/bulk-approve', {
          refundIds: selectedRefundIds,
        });
        if (res && res.success) {
          showAlert(res.message || 'Batch approved successfully.');
          setSelectedRefundIds([]);
          fetchData();
        }
      } else {
        // Update each item to target status
        await Promise.all(
          selectedRefundIds.map((id) =>
            adminApi.put(`/api/admin/refunds/${id}`, {
              status: targetStatus,
              adminNotes: `Batch updated to ${targetStatus} by administrator.`,
            })
          )
        );
        showAlert(`${selectedRefundIds.length} refunds set to ${targetStatus}.`);
        setSelectedRefundIds([]);
        fetchData();
      }
    } catch (err: any) {
      showAlert(err.message || 'Batch status change failed.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleExportCsv = () => {
    if (activeTab === 'REFUNDS') {
      const columns = [
        { header: 'Refund ID', accessor: (r: AdminRefund) => r.id },
        { header: 'Order Number', accessor: (r: AdminRefund) => r.orderNumber },
        { header: 'Customer Name', accessor: (r: AdminRefund) => r.customerName },
        { header: 'Customer Phone', accessor: (r: AdminRefund) => r.customerPhone || 'N/A' },
        { header: 'City', accessor: (r: AdminRefund) => r.cityName || 'Bengaluru' },
        { header: 'Amount (INR)', accessor: (r: AdminRefund) => r.amount },
        { header: 'Max Cap', accessor: (r: AdminRefund) => r.maxRefundable },
        { header: 'Status', accessor: (r: AdminRefund) => r.status },
        { header: 'Channel', accessor: (r: AdminRefund) => r.channel || 'UPI_INSTANT' },
        { header: 'Reason', accessor: (r: AdminRefund) => r.reason },
        { header: 'Bank UTR', accessor: (r: AdminRefund) => r.bankUtr || r.transactionId || 'N/A' },
        { header: 'Created At', accessor: (r: AdminRefund) => r.createdAt },
        { header: 'Approved By', accessor: (r: AdminRefund) => r.approvedBy || 'N/A' },
      ];
      exportToCsv(`refunds_desk_${new Date().toISOString().slice(0, 10)}.csv`, columns, filteredRefunds);
      showAlert('Refund dataset exported successfully.');
    } else {
      const columns = [
        { header: 'Dispute ID', accessor: (d: AdminRefundDispute) => d.id },
        { header: 'Order Number', accessor: (d: AdminRefundDispute) => d.orderNumber },
        { header: 'Claim Ref', accessor: (d: AdminRefundDispute) => d.claimReference },
        { header: 'Customer', accessor: (d: AdminRefundDispute) => d.customerName },
        { header: 'Bank', accessor: (d: AdminRefundDispute) => d.bankName },
        { header: 'Amount', accessor: (d: AdminRefundDispute) => d.disputeAmount },
        { header: 'Status', accessor: (d: AdminRefundDispute) => d.status },
        { header: 'Created At', accessor: (d: AdminRefundDispute) => d.filedAt },
      ];
      exportToCsv(`chargeback_disputes_${new Date().toISOString().slice(0, 10)}.csv`, columns, filteredDisputes);
      showAlert('Disputes dataset exported successfully.');
    }
  };

  // KPIs
  const completedRefunds = refunds.filter((r) => r.status === 'COMPLETED');
  const pendingRefunds = refunds.filter((r) => r.status === 'PENDING');
  const onHoldRefunds = refunds.filter((r) => r.status === 'ON_HOLD');
  const totalRefundedSum = completedRefunds.reduce((acc, curr) => acc + curr.amount, 0);
  const totalPendingSum = pendingRefunds.reduce((acc, curr) => acc + curr.amount, 0);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      
      {/* Action Notification */}
      {actionAlert && (
        <div className={`px-4 py-3 rounded-lg text-xs font-medium flex items-center justify-between border transition-all ${
          actionAlert.type === 'success'
            ? 'bg-emerald-50/70 border-emerald-200 text-emerald-900'
            : 'bg-rose-50/70 border-rose-200 text-rose-900'
        }`}>
          <div className="flex items-center gap-2">
            {actionAlert.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            )}
            <span>{actionAlert.text}</span>
          </div>
          <button onClick={() => setActionAlert(null)} className="text-slate-400 hover:text-slate-700 text-sm leading-none ml-3">
            ✕
          </button>
        </div>
      )}

      {/* Header & Primary Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200/80">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Refunds Desk
          </h1>
        </div>

        <div className="flex items-center gap-2">
          {canCreateRefund && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 shadow-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Initiate Refund</span>
            </button>
          )}

          <button
            onClick={() => setShowPolicyModal(true)}
            className="px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
          >
            <Sliders className="w-3.5 h-3.5 text-slate-500" />
            <span>Policy Rules</span>
          </button>

          {canExport && (
            <button
              onClick={handleExportCsv}
              className="px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5 text-slate-500" />
              <span>Export</span>
            </button>
          )}

          <button
            onClick={fetchData}
            title="Refresh Ledger"
            className="p-1.5 bg-white hover:bg-slate-50 text-slate-600 rounded-lg border border-slate-200 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-emerald-600' : ''}`} />
          </button>
        </div>
      </div>

      {/* Unified Stats Ribbon (Decluttered, Non-Boxy) */}
      <div className="bg-white border border-slate-200/80 rounded-xl overflow-hidden shadow-xs">
        <div className="grid grid-cols-2 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-slate-100">
          <div className="p-4 space-y-0.5">
            <span className="text-[11px] font-medium text-slate-500">Disbursed Refunds</span>
            <div className="text-xl font-semibold text-slate-900 tracking-tight">
              ₹{totalRefundedSum.toLocaleString('en-IN')}
            </div>
            <p className="text-[11px] text-slate-500">
              {completedRefunds.length} successful payouts
            </p>
          </div>

          <div className="p-4 space-y-0.5">
            <span className="text-[11px] font-medium text-slate-500">Pending Approvals</span>
            <div className="text-xl font-semibold text-amber-600 tracking-tight">
              ₹{totalPendingSum.toLocaleString('en-IN')}
            </div>
            <p className="text-[11px] text-slate-500">
              {pendingRefunds.length} awaiting sign-off
            </p>
          </div>

          <div className="p-4 space-y-0.5">
            <span className="text-[11px] font-medium text-slate-500">On Hold</span>
            <div className="text-xl font-semibold text-slate-900 tracking-tight">
              {onHoldRefunds.length} <span className="text-xs font-normal text-slate-500">cases</span>
            </div>
            <p className="text-[11px] text-slate-500">
              Reverse pickup check
            </p>
          </div>

          <div className="p-4 space-y-0.5">
            <span className="text-[11px] font-medium text-slate-500">Disputes & Chargebacks</span>
            <div className="text-xl font-semibold text-slate-900 tracking-tight">
              {disputes.filter((d) => d.status === 'OPEN' || d.status === 'UNDER_REVIEW').length} <span className="text-xs font-normal text-slate-500">active</span>
            </div>
            <p className="text-[11px] text-slate-500">
              POD evidence ready
            </p>
          </div>
        </div>
      </div>

      {/* Tabs Navigation & Search Bar */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200">
          <div className="flex items-center gap-1 -mb-px">
            <button
              onClick={() => setActiveTab('REFUNDS')}
              className={`pb-2.5 px-3 text-xs font-medium border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === 'REFUNDS'
                  ? 'border-slate-900 text-slate-900 font-semibold'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <span>Refund Queue</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                activeTab === 'REFUNDS' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'
              }`}>
                {refunds.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('DISPUTES')}
              className={`pb-2.5 px-3 text-xs font-medium border-b-2 transition-colors flex items-center gap-2 ${
                activeTab === 'DISPUTES'
                  ? 'border-slate-900 text-slate-900 font-semibold'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <span>Bank Disputes</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                activeTab === 'DISPUTES' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'
              }`}>
                {disputes.length}
              </span>
            </button>
          </div>

          <div className="flex items-center gap-2 pb-2 sm:pb-0">
            {activeTab === 'REFUNDS' && (
              <div className="hidden sm:flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg border border-slate-200/80">
                <button
                  onClick={() => setViewMode('table')}
                  className={`p-1.5 rounded-md text-xs transition-colors ${
                    viewMode === 'table' ? 'bg-white text-slate-900 shadow-2xs font-medium' : 'text-slate-500 hover:text-slate-800'
                  }`}
                  title="Table View"
                >
                  <List className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-1.5 rounded-md text-xs transition-colors ${
                    viewMode === 'grid' ? 'bg-white text-slate-900 shadow-2xs font-medium' : 'text-slate-500 hover:text-slate-800'
                  }`}
                  title="Grid View"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Integrated Filter Row */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5 pt-1">
          <div className="flex-1 relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder={
                activeTab === 'REFUNDS'
                  ? 'Search by Order ID, customer name, phone, UTR or reason...'
                  : 'Search disputes by Claim Ref, bank, customer...'
              }
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-900 transition-colors"
            />
          </div>

          {activeTab === 'REFUNDS' && (
            <div className="flex items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-900"
              >
                <option value="ALL">All Statuses</option>
                <option value="PENDING">Pending Review</option>
                <option value="APPROVED">Approved</option>
                <option value="COMPLETED">Disbursed</option>
                <option value="ON_HOLD">On Hold</option>
                <option value="REJECTED">Declined</option>
              </select>

              <select
                value={channelFilter}
                onChange={(e) => setChannelFilter(e.target.value)}
                className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-900"
              >
                <option value="ALL">All Channels</option>
                <option value="UPI_INSTANT">Instant UPI</option>
                <option value="SOURCE_ACCOUNT">Original Method</option>
                <option value="TRADE_CREDIT">Trade Credit</option>
                <option value="BANK_NEFT_IMPS">Bank NEFT</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Bulk Action Bar for Refunds */}
      {activeTab === 'REFUNDS' && selectedRefundIds.length > 0 && (
        <div className="p-3 bg-slate-900 text-white rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs animate-in fade-in duration-150">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{selectedRefundIds.length} refund requests selected:</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {canApproveRefund && (
              <>
                <button
                  onClick={() => handleBulkStatusChange('APPROVED')}
                  className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold transition-colors flex items-center gap-1 shadow-2xs"
                >
                  <CheckCircle2 className="w-3 h-3" />
                  <span>Approve</span>
                </button>
                <button
                  onClick={() => handleBulkStatusChange('PENDING')}
                  className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-semibold transition-colors flex items-center gap-1 shadow-2xs"
                >
                  <Clock className="w-3 h-3" />
                  <span>Pending</span>
                </button>
                <button
                  onClick={() => handleBulkStatusChange('ON_HOLD')}
                  className="px-2.5 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-semibold transition-colors flex items-center gap-1 shadow-2xs"
                >
                  <PauseCircle className="w-3 h-3" />
                  <span>Hold</span>
                </button>
                <button
                  onClick={() => handleBulkStatusChange('REJECTED')}
                  className="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-semibold transition-colors flex items-center gap-1 shadow-2xs"
                >
                  <Ban className="w-3 h-3" />
                  <span>Decline</span>
                </button>
                <button
                  onClick={() => handleBulkStatusChange('COMPLETED')}
                  className="px-2.5 py-1 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-xs font-semibold transition-colors flex items-center gap-1 shadow-2xs"
                >
                  <Zap className="w-3 h-3" />
                  <span>Refunded</span>
                </button>
              </>
            )}
            <button
              onClick={() => setSelectedRefundIds([])}
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium ml-1"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* ==================== TAB 1: REFUNDS DESK ==================== */}
      {activeTab === 'REFUNDS' && (
        <>
          {viewMode === 'table' ? (
            <div className="bg-white border border-slate-200/80 rounded-xl overflow-hidden shadow-xs">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs min-w-[820px]">
                  <thead className="bg-slate-50/75 text-slate-500 font-medium text-[11px] border-b border-slate-200/80">
                    <tr>
                      <th className="py-3 px-3 w-10 text-center">
                        <button onClick={handleSelectAll} className="text-slate-400 hover:text-slate-700 transition-colors">
                          {selectedRefundIds.length === filteredRefunds.length && filteredRefunds.length > 0 ? (
                            <CheckSquare className="w-4 h-4 text-slate-900" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </th>
                      <th className="py-3 px-3.5 w-40">Order</th>
                      <th className="py-3 px-3.5 w-48">Customer</th>
                      <th className="py-3 px-3.5">Reason & Channel</th>
                      <th className="py-3 px-3.5 w-28 text-right">Amount</th>
                      <th className="py-3 px-3.5 w-28 text-center">Status</th>
                      <th className="py-3 px-4 w-40 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {filteredRefunds.length > 0 ? (
                      filteredRefunds.map((ref) => {
                        const custMatch = ref.customerName.match(/^(.*?)\s*\((.*?)\)$/);
                        const cleanCustName = custMatch ? custMatch[1].trim() : ref.customerName;
                        const cleanCustCompany = custMatch ? custMatch[2].trim() : null;

                        return (
                          <tr key={ref.id} className="hover:bg-slate-50/70 transition-colors">
                            <td className="py-3.5 px-3 text-center">
                              <button onClick={() => handleToggleSelect(ref.id)} className="text-slate-400 hover:text-slate-700">
                                {selectedRefundIds.includes(ref.id) ? (
                                  <CheckSquare className="w-4 h-4 text-slate-900" />
                                ) : (
                                  <Square className="w-4 h-4" />
                                )}
                              </button>
                            </td>

                            <td className="py-3.5 px-3.5 whitespace-nowrap">
                              <div className="font-semibold text-slate-900 font-mono text-xs">{ref.orderNumber}</div>
                              <div className="text-[11px] text-slate-400 mt-0.5">
                                {ref.cityName || 'Bengaluru'} • {ref.createdAt.replace('Today, ', '')}
                              </div>
                            </td>

                            <td className="py-3.5 px-3.5">
                              <div className="font-medium text-slate-900 truncate max-w-[170px]" title={ref.customerName}>
                                {cleanCustName}
                              </div>
                              <div className="text-[11px] text-slate-400 truncate max-w-[170px] mt-0.5">
                                {cleanCustCompany || ref.customerPhone || 'Verified Account'}
                              </div>
                            </td>

                            <td className="py-3.5 px-3.5 max-w-sm">
                              <div className="text-slate-800 truncate" title={ref.reason}>
                                {ref.reason}
                              </div>
                              <div className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                                <span>{ref.channel === 'UPI_INSTANT' ? 'Instant UPI' : ref.channel === 'SOURCE_ACCOUNT' ? 'Original Source' : ref.channel === 'TRADE_CREDIT' ? 'Trade Credit' : ref.channel || 'Standard'}</span>
                                {ref.sellerClawback && (
                                  <span className="text-amber-700 font-medium">• Clawback</span>
                                )}
                                {ref.bankUtr && (
                                  <span className="text-slate-400 font-mono">• UTR: {ref.bankUtr.slice(0, 12)}</span>
                                )}
                              </div>
                            </td>

                            <td className="py-3.5 px-3.5 text-right font-mono whitespace-nowrap">
                              <div className="font-semibold text-slate-900 text-sm">
                                ₹{ref.amount.toLocaleString('en-IN')}
                              </div>
                            </td>

                            <td className="py-3.5 px-3.5 text-center whitespace-nowrap">
                              {ref.status === 'COMPLETED' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60">
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                  Disbursed
                                </span>
                              ) : ref.status === 'APPROVED' || ref.status === 'PROCESSING' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-sky-50 text-sky-700 border border-sky-200/60">
                                  <span className="w-1.5 h-1.5 rounded-full bg-sky-500" />
                                  Approved
                                </span>
                              ) : ref.status === 'ON_HOLD' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-purple-50 text-purple-700 border border-purple-200/60">
                                  <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                                  On Hold
                                </span>
                              ) : ref.status === 'REJECTED' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-600 border border-slate-200">
                                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                                  Declined
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200/60">
                                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                                  Pending
                                </span>
                              )}
                            </td>

                            <td className="py-3.5 px-4 text-right whitespace-nowrap">
                              <div className="flex items-center justify-end gap-1.5 relative">
                                {canApproveRefund && ref.status === 'PENDING' && (
                                  <button
                                    onClick={() => setActionModalConfig({ refund: ref, type: 'APPROVE' })}
                                    title="Approve & Disburse"
                                    className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-medium transition-colors flex items-center gap-1 shadow-xs"
                                  >
                                    <CheckCircle2 className="w-3 h-3" />
                                    <span>Approve</span>
                                  </button>
                                )}

                                {canApproveRefund && ref.status === 'ON_HOLD' && (
                                  <button
                                    onClick={() => setActionModalConfig({ refund: ref, type: 'HOLD' })}
                                    title="Release Hold"
                                    className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded text-xs font-medium transition-colors shadow-xs"
                                  >
                                    Release
                                  </button>
                                )}

                                {/* Options Buttons Dropdown List */}
                                <div className="relative inline-block text-left">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setActiveOptionsId(activeOptionsId === ref.id ? null : ref.id);
                                    }}
                                    title="Status options & actions"
                                    className={`px-2 py-1 rounded text-xs font-medium border transition-colors flex items-center gap-1 ${
                                      activeOptionsId === ref.id
                                        ? 'bg-slate-900 text-white border-slate-900'
                                        : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-200 shadow-2xs'
                                    }`}
                                  >
                                    <span>Options</span>
                                    <ChevronDown className="w-3 h-3" />
                                  </button>

                                  {activeOptionsId === ref.id && (
                                    <div
                                      onClick={(e) => e.stopPropagation()}
                                      className="absolute right-0 mt-1.5 w-44 bg-white border border-slate-200 rounded-xl shadow-lg py-1 z-50 text-left animate-in fade-in zoom-in-95 duration-100 divide-y divide-slate-100"
                                    >
                                      <div className="py-1">
                                        <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                          Update Status
                                        </div>

                                        <button
                                          onClick={() => handleStatusChange(ref, 'APPROVED')}
                                          disabled={!canApproveRefund || ref.status === 'APPROVED' || ref.status === 'COMPLETED'}
                                          className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-emerald-50 hover:text-emerald-800 flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                                        >
                                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                          <span className="font-medium">Approve</span>
                                          {ref.status === 'APPROVED' && <span className="ml-auto text-[10px] text-emerald-600 font-semibold">Current</span>}
                                        </button>

                                        <button
                                          onClick={() => handleStatusChange(ref, 'PENDING')}
                                          disabled={!canApproveRefund || ref.status === 'PENDING'}
                                          className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-amber-50 hover:text-amber-800 flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                                        >
                                          <Clock className="w-3.5 h-3.5 text-amber-600" />
                                          <span className="font-medium">Pending</span>
                                          {ref.status === 'PENDING' && <span className="ml-auto text-[10px] text-amber-600 font-semibold">Current</span>}
                                        </button>

                                        <button
                                          onClick={() => handleStatusChange(ref, 'ON_HOLD')}
                                          disabled={!canApproveRefund || ref.status === 'ON_HOLD'}
                                          className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-purple-50 hover:text-purple-800 flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                                        >
                                          <PauseCircle className="w-3.5 h-3.5 text-purple-600" />
                                          <span className="font-medium">Hold</span>
                                          {ref.status === 'ON_HOLD' && <span className="ml-auto text-[10px] text-purple-600 font-semibold">Current</span>}
                                        </button>

                                        <button
                                          onClick={() => handleStatusChange(ref, 'REJECTED')}
                                          disabled={!canApproveRefund || ref.status === 'REJECTED'}
                                          className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-rose-50 hover:text-rose-800 flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                                        >
                                          <Ban className="w-3.5 h-3.5 text-rose-600" />
                                          <span className="font-medium">Decline</span>
                                          {ref.status === 'REJECTED' && <span className="ml-auto text-[10px] text-rose-600 font-semibold">Current</span>}
                                        </button>

                                        <button
                                          onClick={() => handleStatusChange(ref, 'COMPLETED')}
                                          disabled={!canApproveRefund || ref.status === 'COMPLETED'}
                                          className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-teal-50 hover:text-teal-800 flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                                        >
                                          <Zap className="w-3.5 h-3.5 text-teal-600" />
                                          <span className="font-medium">Refunded</span>
                                          {ref.status === 'COMPLETED' && <span className="ml-auto text-[10px] text-teal-600 font-semibold">Current</span>}
                                        </button>
                                      </div>

                                      <div className="py-1">
                                        <button
                                          onClick={() => {
                                            setActiveOptionsId(null);
                                            setSelectedRefundForDetail(ref);
                                          }}
                                          className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-slate-50 flex items-center gap-2 transition-colors"
                                        >
                                          <Eye className="w-3.5 h-3.5 text-slate-500" />
                                          <span>View Details</span>
                                        </button>

                                        <button
                                          onClick={() => {
                                            setActiveOptionsId(null);
                                            setEditingRefund(ref);
                                          }}
                                          className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-slate-50 flex items-center gap-2 transition-colors"
                                        >
                                          <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
                                          <span>Edit Record</span>
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>

                                <button
                                  onClick={() => setSelectedRefundForDetail(ref)}
                                  title="View Details"
                                  className="px-2 py-1 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded text-xs font-medium transition-colors"
                                >
                                  View
                                </button>

                                <button
                                  onClick={() => setEditingRefund(ref)}
                                  title="Edit Refund"
                                  className="px-2 py-1 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded text-xs font-medium transition-colors"
                                >
                                  Edit
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={7} className="py-10 text-center text-slate-400 text-xs">
                          No matching refund records found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            /* Grid View */
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {filteredRefunds.map((ref) => (
                <div
                  key={ref.id}
                  className="bg-white border border-slate-200/80 rounded-xl p-4 shadow-xs hover:border-slate-300 transition-all space-y-3 relative"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-semibold text-slate-900 font-mono text-sm">{ref.orderNumber}</span>
                      <span className="text-[11px] text-slate-500 block">{ref.cityName || 'Bengaluru'}</span>
                    </div>
                    {ref.status === 'COMPLETED' ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        Disbursed
                      </span>
                    ) : ref.status === 'ON_HOLD' ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-purple-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                        On Hold
                      </span>
                    ) : ref.status === 'REJECTED' ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                        Declined
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                        Pending
                      </span>
                    )}
                  </div>

                  <div className="space-y-0.5 text-xs">
                    <p className="font-medium text-slate-900">{ref.customerName}</p>
                    <p className="text-slate-500 line-clamp-2 text-[11px]">{ref.reason}</p>
                  </div>

                  <div className="py-2.5 px-3 bg-slate-50/75 rounded-lg flex items-center justify-between">
                    <div>
                      <span className="text-[10px] text-slate-400 block font-medium">Refund Amount</span>
                      <span className="text-sm font-semibold text-slate-900 font-mono">
                        ₹{ref.amount.toLocaleString('en-IN')}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] text-slate-400 block font-medium">Payout Method</span>
                      <span className="text-xs font-medium text-slate-700">
                        {ref.channel === 'UPI_INSTANT' ? 'Instant UPI' : ref.channel || 'Standard'}
                      </span>
                    </div>
                  </div>

                  {ref.bankUtr && (
                    <p className="text-[11px] text-slate-500 font-mono truncate">
                      UTR: {ref.bankUtr}
                    </p>
                  )}

                  <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setSelectedRefundForDetail(ref)}
                        className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200/80 text-slate-700 rounded text-xs font-medium transition-colors"
                      >
                        Details
                      </button>
                      <button
                        onClick={() => setEditingRefund(ref)}
                        className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200/80 text-slate-700 rounded text-xs font-medium transition-colors"
                      >
                        Edit
                      </button>
                    </div>

                    <div className="flex items-center gap-1.5 relative">
                      {canApproveRefund && ref.status === 'PENDING' && (
                        <button
                          onClick={() => setActionModalConfig({ refund: ref, type: 'APPROVE' })}
                          className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-medium transition-colors flex items-center gap-1"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Approve</span>
                        </button>
                      )}

                      {/* Options Button in Grid Card */}
                      <div className="relative">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveOptionsId(activeOptionsId === ref.id ? null : ref.id);
                          }}
                          className={`px-2 py-1 rounded text-xs font-medium border transition-colors flex items-center gap-1 ${
                            activeOptionsId === ref.id
                              ? 'bg-slate-900 text-white border-slate-900'
                              : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-200 shadow-2xs'
                          }`}
                        >
                          <span>Options</span>
                          <ChevronDown className="w-3 h-3" />
                        </button>

                        {activeOptionsId === ref.id && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="absolute right-0 bottom-full mb-1 w-44 bg-white border border-slate-200 rounded-xl shadow-xl py-1 z-50 text-left animate-in fade-in zoom-in-95 duration-100 divide-y divide-slate-100"
                          >
                            <div className="py-1">
                              <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                                Update Status
                              </div>

                              <button
                                onClick={() => handleStatusChange(ref, 'APPROVED')}
                                disabled={!canApproveRefund || ref.status === 'APPROVED' || ref.status === 'COMPLETED'}
                                className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-emerald-50 hover:text-emerald-800 flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                <span className="font-medium">Approve</span>
                                {ref.status === 'APPROVED' && <span className="ml-auto text-[10px] text-emerald-600 font-semibold">Current</span>}
                              </button>

                              <button
                                onClick={() => handleStatusChange(ref, 'PENDING')}
                                disabled={!canApproveRefund || ref.status === 'PENDING'}
                                className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-amber-50 hover:text-amber-800 flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                              >
                                <Clock className="w-3.5 h-3.5 text-amber-600" />
                                <span className="font-medium">Pending</span>
                                {ref.status === 'PENDING' && <span className="ml-auto text-[10px] text-amber-600 font-semibold">Current</span>}
                              </button>

                              <button
                                onClick={() => handleStatusChange(ref, 'ON_HOLD')}
                                disabled={!canApproveRefund || ref.status === 'ON_HOLD'}
                                className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-purple-50 hover:text-purple-800 flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                              >
                                <PauseCircle className="w-3.5 h-3.5 text-purple-600" />
                                <span className="font-medium">Hold</span>
                                {ref.status === 'ON_HOLD' && <span className="ml-auto text-[10px] text-purple-600 font-semibold">Current</span>}
                              </button>

                              <button
                                onClick={() => handleStatusChange(ref, 'REJECTED')}
                                disabled={!canApproveRefund || ref.status === 'REJECTED'}
                                className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-rose-50 hover:text-rose-800 flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                              >
                                <Ban className="w-3.5 h-3.5 text-rose-600" />
                                <span className="font-medium">Decline</span>
                                {ref.status === 'REJECTED' && <span className="ml-auto text-[10px] text-rose-600 font-semibold">Current</span>}
                              </button>

                              <button
                                onClick={() => handleStatusChange(ref, 'COMPLETED')}
                                disabled={!canApproveRefund || ref.status === 'COMPLETED'}
                                className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-teal-50 hover:text-teal-800 flex items-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                              >
                                <Zap className="w-3.5 h-3.5 text-teal-600" />
                                <span className="font-medium">Refunded</span>
                                {ref.status === 'COMPLETED' && <span className="ml-auto text-[10px] text-teal-600 font-semibold">Current</span>}
                              </button>
                            </div>

                            <div className="py-1">
                              <button
                                onClick={() => {
                                  setActiveOptionsId(null);
                                  setSelectedRefundForDetail(ref);
                                }}
                                className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-slate-50 flex items-center gap-2 transition-colors"
                              >
                                <Eye className="w-3.5 h-3.5 text-slate-500" />
                                <span>View Details</span>
                              </button>

                              <button
                                onClick={() => {
                                  setActiveOptionsId(null);
                                  setEditingRefund(ref);
                                }}
                                className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-slate-50 flex items-center gap-2 transition-colors"
                              >
                                <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
                                <span>Edit Record</span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ==================== TAB 2: CHARGEBACK DISPUTES ==================== */}
      {activeTab === 'DISPUTES' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {filteredDisputes.length > 0 ? (
            filteredDisputes.map((dsp) => (
              <div
                key={dsp.id}
                className="bg-white border border-slate-200/80 rounded-xl p-4 shadow-xs space-y-3"
              >
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <div>
                    <span className="font-semibold text-slate-900 font-mono text-sm">{dsp.claimReference}</span>
                    <p className="text-[11px] text-slate-500">Order: {dsp.orderNumber}</p>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                    dsp.status === 'CLOSED_WON' ? 'bg-emerald-50 text-emerald-700' :
                    dsp.status === 'CONTESTED' ? 'bg-sky-50 text-sky-700' :
                    'bg-amber-50 text-amber-700'
                  }`}>
                    {dsp.status}
                  </span>
                </div>

                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Beneficiary:</span>
                    <span className="font-medium text-slate-900">{dsp.customerName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Issuing Bank:</span>
                    <span className="text-slate-700">{dsp.bankName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Dispute Claim:</span>
                    <span className="font-semibold text-slate-900 font-mono">₹{dsp.disputeAmount.toLocaleString('en-IN')}</span>
                  </div>
                  <div className="p-2.5 bg-slate-50/75 rounded-lg text-slate-700 text-[11px]">
                    "{dsp.reason}"
                  </div>
                </div>

                {dsp.podVerifiedOtp && (
                  <div className="p-2 bg-emerald-50/70 border border-emerald-200/60 rounded-lg text-emerald-800 text-[11px] flex items-center gap-1.5">
                    <FileCheck className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Digital Handover OTP: <strong>{dsp.podVerifiedOtp}</strong></span>
                  </div>
                )}

                <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                  <span className="text-[11px] text-slate-400">{dsp.filedAt}</span>
                  {canApproveRefund && dsp.status !== 'CLOSED_WON' && (
                    <button
                      onClick={() => setSelectedDispute(dsp)}
                      className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-medium transition-colors shadow-xs"
                    >
                      Resolve Dispute
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="col-span-2 p-12 text-center text-slate-400 text-xs bg-white rounded-xl border border-slate-200/80">
              No active chargeback claims or disputes at this time.
            </div>
          )}
        </div>
      )}

      {/* ==================== ACTIVE MODALS ==================== */}

      {/* Create Refund Modal */}
      {showCreateModal && (
        <CreateRefundModal
          orders={orders}
          onClose={() => setShowCreateModal(false)}
          onSuccess={(newRef, msg) => {
            setShowCreateModal(false);
            showAlert(msg);
            fetchData();
          }}
        />
      )}

      {/* Refund Detail Modal */}
      {selectedRefundForDetail && (
        <RefundDetailModal
          refund={selectedRefundForDetail}
          onClose={() => setSelectedRefundForDetail(null)}
          onEdit={(ref) => {
            setSelectedRefundForDetail(null);
            setEditingRefund(ref);
          }}
          onApprove={(ref) => {
            setSelectedRefundForDetail(null);
            setActionModalConfig({ refund: ref, type: 'APPROVE' });
          }}
          onReject={(ref) => {
            setSelectedRefundForDetail(null);
            setActionModalConfig({ refund: ref, type: 'REJECT' });
          }}
          onHold={(ref) => {
            setSelectedRefundForDetail(null);
            setActionModalConfig({ refund: ref, type: 'HOLD' });
          }}
          onRetry={(ref) => {
            setSelectedRefundForDetail(null);
            setActionModalConfig({ refund: ref, type: 'RETRY' });
          }}
          canApprove={canApproveRefund}
        />
      )}

      {/* Refund Action Modal (Approve / Reject / Hold / Retry) */}
      {actionModalConfig && (
        <RefundActionModal
          refund={actionModalConfig.refund}
          actionType={actionModalConfig.type}
          onClose={() => setActionModalConfig(null)}
          onSuccess={(updatedRef, msg) => {
            setActionModalConfig(null);
            showAlert(msg);
            fetchData();
          }}
        />
      )}

      {/* Dispute Resolution Modal */}
      {selectedDispute && (
        <DisputeResolutionModal
          dispute={selectedDispute}
          onClose={() => setSelectedDispute(null)}
          onSuccess={(updatedDispute, msg) => {
            setSelectedDispute(null);
            showAlert(msg);
            fetchData();
          }}
        />
      )}

      {/* Refund Policy Modal */}
      {showPolicyModal && policy && (
        <RefundPolicyModal
          policy={policy}
          onClose={() => setShowPolicyModal(false)}
          onSuccess={(updatedPolicy, msg) => {
            setShowPolicyModal(false);
            setPolicy(updatedPolicy);
            showAlert(msg);
          }}
        />
      )}

      {/* Refund Edit / Full Control Modal */}
      {editingRefund && (
        <RefundEditModal
          refund={editingRefund}
          onClose={() => setEditingRefund(null)}
          onSuccess={(msg) => {
            setEditingRefund(null);
            showAlert(msg);
            fetchData();
          }}
        />
      )}

    </div>
  );
};

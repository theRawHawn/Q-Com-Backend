import React, { useState, useEffect } from 'react';
import {
  Users,
  Search,
  Building2,
  Phone,
  Mail,
  MapPin,
  RefreshCw,
  Download,
  LayoutList,
  Grid,
  ChevronRight,
  ShieldAlert,
  Ban,
  UserCheck,
  UserX,
  AlertTriangle,
  CreditCard,
  LogOut,
  MessageSquare,
  Plus,
  ShieldCheck,
  FileText,
  X,
  Shield,
  Clock,
  Sparkles,
  CheckCircle2
} from 'lucide-react';
import { AdminCustomer, AdminPermission } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';
import { exportToCsv } from '../../utils/exportToSheet';

interface CustomerManagementProps {
  userPermissions: AdminPermission[];
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
}

export const CustomerManagement: React.FC<CustomerManagementProps> = ({
  userPermissions,
  searchQuery: externalSearchQuery,
  onSearchQueryChange,
}) => {
  const [customers, setCustomers] = useState<AdminCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState(externalSearchQuery || '');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'FLAGGED' | 'SUSPENDED' | 'BANNED'>('ALL');
  const [viewMode, setViewMode] = useState<'table' | 'grid'>('table');
  const [selectedCustomer, setSelectedCustomer] = useState<AdminCustomer | null>(null);

  // Administrative action state
  const [actionModal, setActionModal] = useState<{
    customer: AdminCustomer;
    targetStatus: 'ACTIVE' | 'FLAGGED' | 'SUSPENDED' | 'BANNED';
  } | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [actionSubmitting, setActionSubmitting] = useState(false);

  // New Note state
  const [newNoteText, setNewNoteText] = useState('');
  const [noteSubmitting, setNoteSubmitting] = useState(false);

  // Notification Banner
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Active Tab inside Customer Detail Modal
  const [modalTab, setModalTab] = useState<'controls' | 'profile' | 'notes'>('controls');

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

  const canViewSensitive = userPermissions.includes('customers.view_sensitive');
  const canSuspend = userPermissions.includes('customers.suspend');
  const canEdit = userPermissions.includes('customers.edit');

  const fetchCustomers = async () => {
    try {
      setLoading(true);
      const res: any = await adminApi.get('/api/admin/customers');
      if (res.success) {
        setCustomers(res.customers);
        // Keep selectedCustomer in sync if open
        if (selectedCustomer) {
          const updated = res.customers.find((c: AdminCustomer) => c.id === selectedCustomer.id);
          if (updated) setSelectedCustomer(updated);
        }
      }
    } catch (err) {
      console.error('Failed to load customers:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCustomers();
  }, []);

  const filtered = customers.filter((c) => {
    const matchesSearch =
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.phone.includes(searchQuery) ||
      (c.companyName && c.companyName.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (c.savedGstins && c.savedGstins.some((g) => g.gstin.toLowerCase().includes(searchQuery.toLowerCase())));

    if (statusFilter === 'ALL') return matchesSearch;
    return matchesSearch && c.status === statusFilter;
  });

  const countByStatus = (st: 'ACTIVE' | 'FLAGGED' | 'SUSPENDED' | 'BANNED') =>
    customers.filter((c) => c.status === st).length;

  const handleExportCustomers = () => {
    exportToCsv<AdminCustomer>('qcom_customers_directory_sheet', [
      { header: 'Customer ID', accessor: (c) => c.id },
      { header: 'Name', accessor: (c) => c.name },
      { header: 'Phone', accessor: (c) => c.phone },
      { header: 'Email', accessor: (c) => c.email || 'N/A' },
      { header: 'Trade Role', accessor: (c) => c.accountType },
      { header: 'Company Name', accessor: (c) => c.companyName || 'Individual' },
      { header: 'GSTIN', accessor: (c) => c.savedGstins?.[0]?.gstin || 'Unregistered' },
      { header: 'Primary City', accessor: (c) => c.addresses?.[0]?.areaName || 'Bengaluru' },
      { header: 'Status', accessor: (c) => c.status },
      { header: 'Risk Level', accessor: (c) => c.riskLevel || 'LOW' },
      { header: 'Total Orders', accessor: (c) => c.totalOrders },
      { header: 'Total LTV Spend (INR)', accessor: (c) => c.totalSpend },
      { header: 'Joined At', accessor: (c) => c.createdAt },
    ], filtered);
  };

  // Submit Status Change (Activate, Flag, Suspend, Ban)
  const handleExecuteStatusChange = async () => {
    if (!actionModal) return;
    const { customer, targetStatus } = actionModal;

    if ((targetStatus === 'SUSPENDED' || targetStatus === 'BANNED' || targetStatus === 'FLAGGED') && !actionReason.trim()) {
      setFeedbackMsg({ type: 'error', text: 'Administrative justification reason is required for status changes.' });
      return;
    }

    try {
      setActionSubmitting(true);
      const res: any = await adminApi.patch(`/api/admin/customers/${customer.id}/status`, {
        status: targetStatus,
        reason: actionReason.trim(),
      });

      if (res.success) {
        setFeedbackMsg({ type: 'success', text: res.message || `Customer status changed to ${targetStatus}` });
        setActionModal(null);
        setActionReason('');
        await fetchCustomers();
      } else {
        setFeedbackMsg({ type: 'error', text: res.message || 'Failed to update customer status.' });
      }
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Error occurred while updating status.' });
    } finally {
      setActionSubmitting(false);
    }
  };

  // Save Fraud & Risk Controls
  const handleSaveFraudControls = async (
    cust: AdminCustomer,
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
    creditLimitINR: number,
    fraudFlags: string[]
  ) => {
    try {
      const res: any = await adminApi.post(`/api/admin/customers/${cust.id}/fraud-controls`, {
        riskLevel,
        isVip: false,
        creditLimitINR,
        fraudFlags,
      });

      if (res.success) {
        setFeedbackMsg({ type: 'success', text: 'Risk & credit parameters updated successfully.' });
        await fetchCustomers();
      } else {
        setFeedbackMsg({ type: 'error', text: res.message || 'Failed to update controls.' });
      }
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Error updating controls.' });
    }
  };

  // Post Internal Note
  const handleAddNote = async (cust: AdminCustomer) => {
    if (!newNoteText.trim()) return;
    try {
      setNoteSubmitting(true);
      const res: any = await adminApi.post(`/api/admin/customers/${cust.id}/notes`, {
        noteText: newNoteText.trim(),
      });

      if (res.success) {
        setNewNoteText('');
        setFeedbackMsg({ type: 'success', text: 'Audit note added successfully.' });
        await fetchCustomers();
      } else {
        setFeedbackMsg({ type: 'error', text: res.message || 'Failed to post note.' });
      }
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Error posting note.' });
    } finally {
      setNoteSubmitting(false);
    }
  };

  // Force Session Revocation
  const handleResetSession = async (cust: AdminCustomer) => {
    if (!window.confirm(`Force revoke active login sessions for ${cust.name}? User will be logged out immediately across all devices.`)) {
      return;
    }
    try {
      const res: any = await adminApi.post(`/api/admin/customers/${cust.id}/reset-session`, {});
      if (res.success) {
        setFeedbackMsg({ type: 'success', text: res.message || 'Customer session force revoked.' });
        await fetchCustomers();
      } else {
        setFeedbackMsg({ type: 'error', text: res.message || 'Failed to revoke session.' });
      }
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err.message || 'Error revoking session.' });
    }
  };

  const renderStatusBadge = (status: AdminCustomer['status'], flagsCount?: number) => {
    switch (status) {
      case 'ACTIVE':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60 whitespace-nowrap">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Active
          </span>
        );
      case 'FLAGGED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200/60 whitespace-nowrap">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Flagged
            {Boolean(flagsCount && flagsCount > 0) && (
              <span className="text-[10px] bg-amber-100/90 text-amber-900 px-1.5 py-0.2 rounded font-semibold ml-0.5">
                {flagsCount} {flagsCount === 1 ? 'flag' : 'flags'}
              </span>
            )}
          </span>
        );
      case 'SUSPENDED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-orange-50 text-orange-800 border border-orange-200/60 whitespace-nowrap">
            <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
            Suspended
          </span>
        );
      case 'BANNED':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-50 text-rose-800 border border-rose-200/60 whitespace-nowrap">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
            Banned
          </span>
        );
      default:
        return null;
    }
  };

  const renderRiskBadge = (risk?: AdminCustomer['riskLevel']) => {
    switch (risk) {
      case 'CRITICAL':
        return <span className="bg-rose-100 text-rose-800 font-bold px-2 py-0.5 rounded text-[10px] tracking-wider uppercase border border-rose-300">CRITICAL</span>;
      case 'HIGH':
        return <span className="bg-amber-100 text-amber-800 font-bold px-2 py-0.5 rounded text-[10px] tracking-wider uppercase border border-amber-300">HIGH RISK</span>;
      case 'MEDIUM':
        return <span className="bg-sky-100 text-sky-800 font-bold px-2 py-0.5 rounded text-[10px] tracking-wider uppercase border border-sky-300">MEDIUM</span>;
      default:
        return <span className="bg-slate-100 text-slate-600 font-semibold px-2 py-0.5 rounded text-[10px] uppercase border border-slate-200">LOW RISK</span>;
    }
  };

  const AVAILABLE_FRAUD_FLAGS = [
    'Frequent Order Cancellations',
    'Failed / Disputed Payment Chargebacks',
    'Promo / Voucher Coupon Abuse',
    'Unreachable / Fake Site Location',
    'Invalid / Misused GSTIN Claim',
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Toast Feedback */}
      {feedbackMsg && (
        <div
          className={`p-3 rounded-xl border text-xs font-medium flex items-center justify-between shadow-2xs ${
            feedbackMsg.type === 'success'
              ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
              : 'bg-rose-50 text-rose-900 border-rose-200'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedbackMsg.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" />
            )}
            <span>{feedbackMsg.text}</span>
          </div>
          <button
            onClick={() => setFeedbackMsg(null)}
            className="text-slate-400 hover:text-slate-700 p-1"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Customer Directory
          </h1>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          {/* View Toggle */}
          <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200/80">
            <button
              onClick={() => setViewMode('table')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                viewMode === 'table'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
              title="Row List View"
            >
              <LayoutList className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Row List</span>
            </button>
            <button
              onClick={() => setViewMode('grid')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                viewMode === 'grid'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
              title="Card Grid View"
            >
              <Grid className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Cards</span>
            </button>
          </div>

          <button
            onClick={handleExportCustomers}
            className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white px-3.5 py-2 rounded-xl text-xs font-semibold shadow-xs transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export CSV</span>
          </button>
          <button
            onClick={fetchCustomers}
            className="p-2 bg-white hover:bg-slate-50 text-slate-600 rounded-xl border border-slate-200 shadow-xs transition-colors"
            title="Refresh List"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin text-emerald-600' : 'text-slate-500'}`} />
          </button>
        </div>
      </div>

      {/* Filter Tabs & Search Bar */}
      <div className="bg-white border border-slate-200/80 rounded-xl p-3.5 shadow-2xs space-y-3">
        {/* Status Category Tabs */}
        <div className="flex items-center gap-1.5 border-b border-slate-100 pb-2.5 overflow-x-auto text-xs">
          <button
            onClick={() => setStatusFilter('ALL')}
            className={`px-3 py-1.5 rounded-lg font-semibold whitespace-nowrap transition-all ${
              statusFilter === 'ALL'
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            All Accounts ({customers.length})
          </button>
          <button
            onClick={() => setStatusFilter('ACTIVE')}
            className={`px-3 py-1.5 rounded-lg font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              statusFilter === 'ACTIVE'
                ? 'bg-emerald-700 text-white shadow-xs'
                : 'text-slate-600 hover:bg-emerald-50 hover:text-emerald-800'
            }`}
          >
            <span>Active</span>
            <span className="bg-white/20 px-1.5 py-0.2 rounded-md text-[10px]">{countByStatus('ACTIVE')}</span>
          </button>
          <button
            onClick={() => setStatusFilter('FLAGGED')}
            className={`px-3 py-1.5 rounded-lg font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              statusFilter === 'FLAGGED'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'text-slate-600 hover:bg-amber-50 hover:text-amber-800'
            }`}
          >
            <span>Flagged Risk</span>
            <span className="bg-white/20 px-1.5 py-0.2 rounded-md text-[10px]">{countByStatus('FLAGGED')}</span>
          </button>
          <button
            onClick={() => setStatusFilter('SUSPENDED')}
            className={`px-3 py-1.5 rounded-lg font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              statusFilter === 'SUSPENDED'
                ? 'bg-orange-600 text-white shadow-xs'
                : 'text-slate-600 hover:bg-orange-50 hover:text-orange-800'
            }`}
          >
            <span>Suspended</span>
            <span className="bg-white/20 px-1.5 py-0.2 rounded-md text-[10px]">{countByStatus('SUSPENDED')}</span>
          </button>
          <button
            onClick={() => setStatusFilter('BANNED')}
            className={`px-3 py-1.5 rounded-lg font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              statusFilter === 'BANNED'
                ? 'bg-rose-700 text-white shadow-xs'
                : 'text-slate-600 hover:bg-rose-50 hover:text-rose-800'
            }`}
          >
            <span>Banned</span>
            <span className="bg-white/20 px-1.5 py-0.2 rounded-md text-[10px]">{countByStatus('BANNED')}</span>
          </button>
        </div>

        {/* Search Bar Input */}
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search contractor name, phone number, GSTIN or firm name..."
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full bg-slate-50/75 border border-slate-200/80 rounded-lg pl-10 pr-3.5 py-2 text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
          />
        </div>
      </div>

      {/* Customers Content View */}
      {viewMode === 'table' ? (
        /* Row List Table View */
        <div className="bg-white border border-slate-200/80 rounded-xl shadow-xs overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs min-w-[850px]">
              <thead className="bg-slate-50/75 text-slate-500 text-[11px] font-semibold uppercase tracking-wider border-b border-slate-200/80">
                <tr>
                  <th className="py-3 px-4 min-w-[200px]">Customer / Firm</th>
                  <th className="py-3 px-4 min-w-[120px]">Status</th>
                  <th className="py-3 px-4 min-w-[160px]">Contact Details</th>
                  <th className="py-3 px-4 min-w-[150px]">Hub / Area</th>
                  <th className="py-3 px-4 text-center min-w-[70px]">Orders</th>
                  <th className="py-3 px-4 text-right min-w-[100px]">Total Spend</th>
                  <th className="py-3 px-4 text-right pr-6 min-w-[130px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-400 text-xs">
                      No matching customer accounts found for the selected filter.
                    </td>
                  </tr>
                ) : (
                  filtered.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => {
                        setSelectedCustomer(c);
                        setModalTab('controls');
                      }}
                      className="hover:bg-slate-50/70 transition-colors cursor-pointer group"
                    >
                      <td className="py-3.5 px-4">
                        <span className="font-semibold text-slate-900 text-xs">{c.name}</span>
                        {c.companyName ? (
                          <div className="text-[11px] text-sky-700 font-medium truncate max-w-[220px] mt-0.5">
                            {c.companyName}
                          </div>
                        ) : (
                          <div className="text-[11px] text-slate-400 mt-0.5">Individual Account</div>
                        )}
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {renderStatusBadge(c.status, c.fraudFlags?.length)}
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-900">
                          {canViewSensitive ? c.phone : `${c.phone.substring(0, 7)}****`}
                        </div>
                        {c.email && (
                          <div className="text-[11px] text-slate-500 truncate max-w-[180px] mt-0.5">
                            {c.email}
                          </div>
                        )}
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="font-medium text-slate-900 truncate max-w-[180px]">
                          {c.addresses?.[0]?.areaName || 'Bengaluru Central'}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          {c.savedGstins?.length || 0} GSTIN • {c.addresses?.length || 0} Address
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-center font-bold text-slate-900">
                        {c.totalOrders}
                      </td>

                      <td className="py-3.5 px-4 text-right font-bold text-emerald-700 text-xs">
                        ₹{c.totalSpend.toLocaleString('en-IN')}
                      </td>

                      <td className="py-3.5 px-4 text-right pr-6" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                          <button
                            onClick={() => {
                              setSelectedCustomer(c);
                              setModalTab('controls');
                            }}
                            className="inline-flex items-center gap-1.5 text-xs text-slate-700 hover:text-slate-900 font-medium px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200/80 transition-colors shadow-2xs"
                          >
                            <Shield className="h-3.5 w-3.5 text-slate-500" />
                            <span>Manage</span>
                          </button>

                          {canSuspend && (
                            <>
                              {c.status === 'ACTIVE' ? (
                                <button
                                  onClick={() => setActionModal({ customer: c, targetStatus: 'SUSPENDED' })}
                                  className="p-1.5 text-slate-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-colors"
                                  title="Suspend Account"
                                  aria-label="Suspend Account"
                                >
                                  <ShieldAlert className="h-4 w-4" />
                                </button>
                              ) : c.status === 'SUSPENDED' || c.status === 'FLAGGED' || c.status === 'BANNED' ? (
                                <button
                                  onClick={() => setActionModal({ customer: c, targetStatus: 'ACTIVE' })}
                                  className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                                  title="Reactivate Account"
                                  aria-label="Reactivate Account"
                                >
                                  <UserCheck className="h-4 w-4" />
                                </button>
                              ) : null}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Card Grid View */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {filtered.map((c) => (
            <div
              key={c.id}
              onClick={() => {
                setSelectedCustomer(c);
                setModalTab('controls');
              }}
              className="bg-white border border-slate-200/80 rounded-xl p-4 shadow-2xs space-y-3 hover:border-slate-300 cursor-pointer transition-all flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <h3 className="font-semibold text-slate-900 text-sm">{c.name}</h3>
                    </div>
                    {c.companyName && (
                      <p className="text-xs text-sky-700 font-medium mt-0.5 truncate max-w-[200px]">
                        {c.companyName}
                      </p>
                    )}
                    <span className="text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md mt-1.5 inline-block font-medium border border-slate-200">
                      {c.accountType}
                    </span>
                  </div>
                  <div className="text-right">
                    {renderStatusBadge(c.status, c.fraudFlags?.length)}
                  </div>
                </div>

                <div className="mt-3 p-2.5 bg-slate-50/75 rounded-lg border border-slate-200/80 space-y-1.5 text-xs">
                  <div className="flex justify-between text-slate-700">
                    <span className="text-slate-500 font-medium">Phone:</span>
                    <span className="text-slate-900 font-bold">{canViewSensitive ? c.phone : `${c.phone.substring(0, 7)}****`}</span>
                  </div>
                  <div className="flex justify-between text-slate-700">
                    <span className="text-slate-500 font-medium">Total Spend:</span>
                    <span className="text-emerald-700 font-bold">₹{c.totalSpend.toLocaleString('en-IN')}</span>
                  </div>
                  <div className="flex justify-between text-slate-700">
                    <span className="text-slate-500 font-medium">Orders:</span>
                    <span className="text-slate-900 font-bold">{c.totalOrders}</span>
                  </div>
                  {c.creditLimitINR && c.creditLimitINR > 0 ? (
                    <div className="flex justify-between text-slate-700">
                      <span className="text-slate-500 font-medium">Trade Credit Limit:</span>
                      <span className="text-sky-700 font-bold">₹{c.creditLimitINR.toLocaleString('en-IN')}</span>
                    </div>
                  ) : null}
                </div>

                {c.suspensionReason && (
                  <div className="mt-2.5 p-2 bg-rose-50 border border-rose-200 text-rose-800 text-[11px] rounded-lg">
                    <strong className="block font-semibold">Justification Reason:</strong>
                    {c.suspensionReason}
                  </div>
                )}
              </div>

              <div className="pt-2.5 border-t border-slate-100 text-xs text-slate-600 font-medium flex items-center justify-between" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => {
                    setSelectedCustomer(c);
                    setModalTab('controls');
                  }}
                  className="text-slate-900 hover:text-emerald-700 font-semibold flex items-center gap-1.5"
                >
                  <Shield className="h-3.5 w-3.5 text-slate-500" />
                  <span>Manage Account</span>
                </button>
                <ChevronRight className="h-4 w-4 text-slate-400" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Action Status Change Confirmation Modal */}
      {actionModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200/80 rounded-2xl w-full max-w-md p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-amber-600" />
                <h3 className="font-bold text-slate-900 text-sm">
                  Confirm Account Status Change
                </h3>
              </div>
              <button
                onClick={() => setActionModal(null)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs text-slate-700">
              <p>
                You are updating the status for customer{' '}
                <strong className="text-slate-900 font-bold">{actionModal.customer.name}</strong> ({actionModal.customer.phone}) to:
              </p>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-center font-bold">
                {renderStatusBadge(actionModal.targetStatus)}
              </div>

              {actionModal.targetStatus === 'BANNED' && (
                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-[11px] leading-relaxed">
                  ⚠️ <strong>Warning:</strong> Banning an account permanently revokes access to the Q-Commerce platform, invalidates active sessions, and blocks future order placements.
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-900 mb-1">
                  Administrative Justification / Reason <span className="text-rose-500">*</span>
                </label>
                <textarea
                  rows={3}
                  value={actionReason}
                  onChange={(e) => setActionReason(e.target.value)}
                  placeholder="E.g., Repeated fake address, unresolved chargeback dispute #QC-8812, or policy compliance violation..."
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs text-slate-900 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900 placeholder:text-slate-400"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => setActionModal(null)}
                className="px-3.5 py-2 rounded-xl border border-slate-200 text-slate-600 font-semibold text-xs hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                disabled={actionSubmitting}
                onClick={handleExecuteStatusChange}
                className={`px-4 py-2 rounded-xl font-bold text-xs text-white shadow-xs transition-colors ${
                  actionModal.targetStatus === 'BANNED'
                    ? 'bg-rose-700 hover:bg-rose-800'
                    : actionModal.targetStatus === 'SUSPENDED'
                    ? 'bg-orange-600 hover:bg-orange-700'
                    : 'bg-emerald-700 hover:bg-emerald-800'
                }`}
              >
                {actionSubmitting ? 'Updating...' : `Confirm & Apply Status`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Selected Customer In-Depth Administrative Control Modal */}
      {selectedCustomer && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200/80 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-5 shadow-2xl space-y-4">
            {/* Modal Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-slate-900 text-base">{selectedCustomer.name}</h3>
                  {renderStatusBadge(selectedCustomer.status, selectedCustomer.fraudFlags?.length)}
                </div>
                <p className="text-xs text-sky-700 font-medium mt-0.5">
                  {selectedCustomer.companyName || 'Individual Trade Account'} • ID: {selectedCustomer.id}
                </p>
              </div>

              <div className="flex items-center gap-2 self-end sm:self-auto">
                <button
                  onClick={() => setSelectedCustomer(null)}
                  className="text-slate-600 hover:text-slate-900 text-xs font-semibold px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                >
                  Close
                </button>
              </div>
            </div>

            {/* Sub-Tab Navigation */}
            <div className="flex items-center gap-2 border-b border-slate-100 pb-2 text-xs font-semibold">
              <button
                onClick={() => setModalTab('controls')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-all ${
                  modalTab === 'controls'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <Shield className="h-3.5 w-3.5" />
                <span>Fraud & Risk Controls</span>
              </button>
              <button
                onClick={() => setModalTab('profile')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-all ${
                  modalTab === 'profile'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <Building2 className="h-3.5 w-3.5" />
                <span>GSTINs & Sites</span>
              </button>
              <button
                onClick={() => setModalTab('notes')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-all ${
                  modalTab === 'notes'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                <span>Audit Notes ({selectedCustomer.notes?.length || 0})</span>
              </button>
            </div>

            {/* TAB 1: Administrative & Fraud Controls */}
            {modalTab === 'controls' && (
              <div className="space-y-4 text-xs text-slate-700">
                {/* Status Switcher Bar */}
                <div className="p-3.5 bg-slate-50/80 rounded-xl border border-slate-200/80 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900 flex items-center gap-1.5">
                      <ShieldCheck className="h-4 w-4 text-emerald-600" />
                      Account Status Controls
                    </span>
                    <span className="text-[11px] text-slate-500 font-medium">Change account status with justification</span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <button
                      onClick={() => setActionModal({ customer: selectedCustomer, targetStatus: 'ACTIVE' })}
                      className={`p-2.5 rounded-xl border text-center font-bold transition-all ${
                        selectedCustomer.status === 'ACTIVE'
                          ? 'bg-emerald-700 text-white border-emerald-800 shadow-xs ring-2 ring-emerald-300'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-emerald-50 hover:text-emerald-800'
                      }`}
                    >
                      Active
                    </button>
                    <button
                      onClick={() => setActionModal({ customer: selectedCustomer, targetStatus: 'FLAGGED' })}
                      className={`p-2.5 rounded-xl border text-center font-bold transition-all ${
                        selectedCustomer.status === 'FLAGGED'
                          ? 'bg-amber-600 text-white border-amber-700 shadow-xs ring-2 ring-amber-300'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-amber-50 hover:text-amber-800'
                      }`}
                    >
                      Flagged Risk
                    </button>
                    <button
                      onClick={() => setActionModal({ customer: selectedCustomer, targetStatus: 'SUSPENDED' })}
                      className={`p-2.5 rounded-xl border text-center font-bold transition-all ${
                        selectedCustomer.status === 'SUSPENDED'
                          ? 'bg-orange-600 text-white border-orange-700 shadow-xs ring-2 ring-orange-300'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-orange-50 hover:text-orange-800'
                      }`}
                    >
                      Suspend
                    </button>
                    <button
                      onClick={() => setActionModal({ customer: selectedCustomer, targetStatus: 'BANNED' })}
                      className={`p-2.5 rounded-xl border text-center font-bold transition-all ${
                        selectedCustomer.status === 'BANNED'
                          ? 'bg-rose-700 text-white border-rose-800 shadow-xs ring-2 ring-rose-300'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-rose-50 hover:text-rose-800'
                      }`}
                    >
                      Ban Account
                    </button>
                  </div>

                  {selectedCustomer.suspensionReason && (
                    <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-900 rounded-lg text-xs leading-relaxed">
                      <strong>Current Justification Note:</strong> {selectedCustomer.suspensionReason}
                    </div>
                  )}
                </div>

                {/* Risk Level & Fraud Flags Matrix */}
                <div className="p-3.5 bg-slate-50/80 rounded-xl border border-slate-200/80 space-y-3">
                  <span className="font-bold text-slate-900 block flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    Risk & Credit Controls
                  </span>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Risk Level Selector */}
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Assigned Risk Rating</label>
                      <select
                        value={selectedCustomer.riskLevel || 'LOW'}
                        onChange={(e) =>
                          handleSaveFraudControls(
                            selectedCustomer,
                            e.target.value as any,
                            selectedCustomer.creditLimitINR || 0,
                            selectedCustomer.fraudFlags || []
                          )
                        }
                        className="w-full bg-white border border-slate-200 rounded-lg p-2 font-semibold text-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 text-xs"
                      >
                        <option value="LOW">🟢 Low Risk (Standard)</option>
                        <option value="MEDIUM">🟡 Medium Risk (Monitored)</option>
                        <option value="HIGH">🟠 High Risk (Manual Verification)</option>
                        <option value="CRITICAL">🔴 Critical Risk (High Fraud Threat)</option>
                      </select>
                    </div>

                    {/* Trade Credit Limit */}
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">B2B Trade Credit Limit (INR)</label>
                      <input
                        type="number"
                        value={selectedCustomer.creditLimitINR || 0}
                        onChange={(e) =>
                          handleSaveFraudControls(
                            selectedCustomer,
                            selectedCustomer.riskLevel || 'LOW',
                            Number(e.target.value),
                            selectedCustomer.fraudFlags || []
                          )
                        }
                        placeholder="E.g. 150000"
                        className="w-full bg-white border border-slate-200 rounded-lg p-2 font-semibold text-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 text-xs"
                      />
                    </div>
                  </div>

                  {/* Fraud Flags Selector */}
                  <div className="space-y-1.5">
                    <label className="block font-semibold text-slate-700">Active Fraud Risk Flags</label>
                    <div className="space-y-1 bg-white p-2.5 rounded-lg border border-slate-200">
                      {AVAILABLE_FRAUD_FLAGS.map((flag) => {
                        const isChecked = selectedCustomer.fraudFlags?.includes(flag) || false;
                        return (
                          <label key={flag} className="flex items-center gap-2 py-1 px-1.5 hover:bg-slate-50 rounded cursor-pointer text-xs">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                const newFlags = e.target.checked
                                  ? [...(selectedCustomer.fraudFlags || []), flag]
                                  : (selectedCustomer.fraudFlags || []).filter((f) => f !== flag);
                                handleSaveFraudControls(
                                  selectedCustomer,
                                  selectedCustomer.riskLevel || 'LOW',
                                  selectedCustomer.creditLimitINR || 0,
                                  newFlags
                                );
                              }}
                              className="rounded text-emerald-600 focus:ring-emerald-500"
                            />
                            <span className={`font-medium ${isChecked ? 'text-rose-700 font-bold' : 'text-slate-700'}`}>
                              {flag}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Security Action: Session Revocation */}
                <div className="p-3.5 bg-rose-50/70 rounded-xl border border-rose-200 flex items-center justify-between">
                  <div>
                    <span className="font-bold text-rose-900 block flex items-center gap-1.5">
                      <LogOut className="h-4 w-4 text-rose-600" />
                      Session Invalidation & Force Logout
                    </span>
                    <span className="text-[11px] text-rose-700">
                      Revokes all active auth tokens for {selectedCustomer.name}. Customer will be forced to re-verify via SMS OTP.
                    </span>
                  </div>

                  <button
                    onClick={() => handleResetSession(selectedCustomer)}
                    className="bg-rose-700 hover:bg-rose-800 text-white font-bold px-3.5 py-2 rounded-xl text-xs shadow-xs transition-colors shrink-0"
                  >
                    Force Logout
                  </button>
                </div>
              </div>
            )}

            {/* TAB 2: Profile, GSTINs & Delivery Addresses */}
            {modalTab === 'profile' && (
              <div className="space-y-4 text-xs text-slate-700">
                <div className="grid grid-cols-2 gap-3 bg-slate-50/75 p-3.5 rounded-xl border border-slate-200/80">
                  <div>
                    <span className="text-slate-500 block mb-0.5 text-xs font-medium">Contact Number:</span>
                    <span className="text-slate-900 font-bold">{selectedCustomer.phone}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block mb-0.5 text-xs font-medium">Email Address:</span>
                    <span className="text-slate-900 font-bold">{selectedCustomer.email || 'N/A'}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block mb-0.5 text-xs font-medium">Customer Since:</span>
                    <span className="text-slate-900 font-bold">{selectedCustomer.createdAt}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block mb-0.5 text-xs font-medium">Last Active:</span>
                    <span className="text-emerald-700 font-bold">{selectedCustomer.lastActive}</span>
                  </div>
                </div>

                {/* Saved GSTINs */}
                <div className="space-y-2">
                  <span className="font-bold text-slate-900 block text-xs">
                    Verified Business GSTIN Claims
                  </span>
                  {selectedCustomer.savedGstins && selectedCustomer.savedGstins.length > 0 ? (
                    selectedCustomer.savedGstins.map((g, i) => (
                      <div key={i} className="p-3 bg-slate-50/75 border border-slate-200/80 rounded-xl flex justify-between items-center">
                        <div>
                          <span className="font-bold text-slate-900">{g.gstin}</span>
                          <p className="text-xs text-slate-600 mt-0.5">{g.legalName}</p>
                        </div>
                        <span className="text-[11px] bg-slate-200/80 text-slate-800 px-2.5 py-0.5 rounded-full font-bold">{g.state}</span>
                      </div>
                    ))
                  ) : (
                    <p className="text-slate-400 italic">No business GSTIN registered for this account.</p>
                  )}
                </div>

                {/* Delivery Locations */}
                <div className="space-y-2">
                  <span className="font-bold text-slate-900 block text-xs">
                    Saved Drop Site Locations
                  </span>
                  {selectedCustomer.addresses && selectedCustomer.addresses.length > 0 ? (
                    selectedCustomer.addresses.map((a, i) => (
                      <div key={i} className="p-3 bg-slate-50/75 border border-slate-200/80 rounded-xl">
                        <span className="font-bold text-slate-900">{a.label}</span>
                        <p className="text-xs text-slate-600 mt-0.5">{a.address}</p>
                        <span className="text-[11px] text-sky-800 bg-sky-50 border border-sky-200/80 px-2 py-0.5 rounded-md mt-1.5 inline-block font-semibold">
                          {a.areaName}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-slate-400 italic">No drop sites logged.</p>
                  )}
                </div>
              </div>
            )}

            {/* TAB 3: Internal Audit Notes */}
            {modalTab === 'notes' && (
              <div className="space-y-4 text-xs text-slate-700">
                {/* Post New Note */}
                <div className="p-3.5 bg-slate-50/80 rounded-xl border border-slate-200 space-y-2">
                  <label className="block font-bold text-slate-900">Add Administrative Internal Note</label>
                  <textarea
                    rows={2}
                    value={newNoteText}
                    onChange={(e) => setNewNoteText(e.target.value)}
                    placeholder="Write internal notes, telephonic audit summary, or policy verification details..."
                    className="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
                  />
                  <div className="flex justify-end">
                    <button
                      disabled={noteSubmitting || !newNoteText.trim()}
                      onClick={() => handleAddNote(selectedCustomer)}
                      className="bg-slate-900 hover:bg-slate-800 text-white font-bold px-3.5 py-1.5 rounded-lg text-xs transition-colors disabled:opacity-50"
                    >
                      {noteSubmitting ? 'Posting...' : 'Post Audit Note'}
                    </button>
                  </div>
                </div>

                {/* Existing Notes List */}
                <div className="space-y-2.5">
                  <span className="font-bold text-slate-900 block text-xs">
                    History & Audit Trail
                  </span>
                  {selectedCustomer.notes && selectedCustomer.notes.length > 0 ? (
                    selectedCustomer.notes.map((n) => (
                      <div key={n.id} className="p-3 bg-white border border-slate-200 rounded-xl space-y-1 shadow-2xs">
                        <div className="flex justify-between items-center text-[11px]">
                          <span className="font-bold text-slate-900">{n.author}</span>
                          <span className="text-slate-400">{n.createdAt}</span>
                        </div>
                        <p className="text-slate-700 leading-relaxed text-xs">{n.text}</p>
                      </div>
                    ))
                  ) : (
                    <div className="p-6 text-center text-slate-400 italic bg-slate-50 rounded-xl border border-dashed border-slate-200">
                      No internal notes recorded for this customer yet.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

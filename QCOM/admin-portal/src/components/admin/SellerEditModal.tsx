import React, { useState } from 'react';
import {
  X,
  Store,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  AlertTriangle,
  Building,
  CreditCard,
  FileText,
  Clock,
  MapPin,
  Power,
  Percent,
  TrendingUp,
  Save,
  Trash2,
  Ban,
  RotateCcw,
  Sliders,
  UserCheck
} from 'lucide-react';
import { AdminSeller, NON_FOOD_GROCERY_CATEGORIES } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';
import { StoreCategorySelector } from './StoreCategorySelector';
import { SellerEarningsBreakdown } from './SellerEarningsBreakdown';

interface SellerEditModalProps {
  seller: AdminSeller;
  onClose: () => void;
  onRefresh: () => void;
  canEdit: boolean;
  canSuspend: boolean;
  canEditCommission: boolean;
}

export const SellerEditModal: React.FC<SellerEditModalProps> = ({
  seller,
  onClose,
  onRefresh,
  canEdit,
  canSuspend,
  canEditCommission,
}) => {
  const [activeTab, setActiveTab] = useState<'IDENTITY' | 'OPERATIONS' | 'KYC' | 'COMMERCIALS' | 'EARNINGS' | 'ENFORCEMENT'>('IDENTITY');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Form States initialized with seller data
  const [formData, setFormData] = useState({
    name: seller.name || '',
    ownerName: seller.ownerName || '',
    hubType: seller.hubType || '',
    categories: (seller.categories && seller.categories.length > 0)
      ? seller.categories
      : ['Electrical & Lighting', 'Hardware & Fasteners'],
    phone: seller.phone || '',
    email: seller.email || '',
    areaName: seller.areaName || '',
    cityId: seller.cityId || 'bengaluru',
    address: typeof seller.address === 'string' ? seller.address : (seller.address?.street || ''),
    gstin: seller.gstin || '',
    panNumber: seller.panNumber || '',
    accountNumber: seller.bankAccount?.accountNumber || '',
    ifsc: seller.bankAccount?.ifsc || '',
    bankName: seller.bankAccount?.bankName || '',
    commissionRatePercent: Math.max(15.0, seller.commissionRatePercent ?? 15.0),
    avgPrepTimeMins: seller.avgPrepTimeMins ?? 5.0,
    slaAdherencePercent: seller.slaAdherencePercent ?? 98.5,
    isStoreOnline: seller.isStoreOnline ?? true,
    canReceiveOrders: seller.canReceiveOrders ?? true,
    isOrderingEnabled: seller.isOrderingEnabled ?? true,
    status: seller.status || 'ACTIVE',
    suspensionReason: seller.suspensionReason || '',
    rejectionReason: seller.rejectionReason || '',
    gstVerified: seller.documents?.gstVerified ?? true,
    panVerified: seller.documents?.panVerified ?? true,
    bankVerified: seller.documents?.bankVerified ?? true,
    tradeLicenseVerified: seller.documents?.tradeLicenseVerified ?? true,
    tradeLicenseNumber: seller.documents?.tradeLicenseNumber || 'TL-BBMP-2026-9812',
  });

  const [showSuspendConfirm, setShowSuspendConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [suspendInputReason, setSuspendInputReason] = useState(seller.suspensionReason || 'Operational SLA breach or documentation audit');

  const handleSaveAll = async () => {
    try {
      setIsSubmitting(true);
      setErrorMsg('');
      setSuccessMsg('');

      if (formData.status !== seller.status && !formData.suspensionReason?.trim()) {
        setErrorMsg('Reason for status change is required (*)');
        setIsSubmitting(false);
        return;
      }

      const payload = {
        name: formData.name,
        ownerName: formData.ownerName,
        hubType: formData.hubType,
        categories: formData.categories,
        phone: formData.phone,
        email: formData.email,
        areaName: formData.areaName,
        cityId: formData.cityId,
        address: formData.address,
        gstin: formData.gstin,
        panNumber: formData.panNumber,
        bankAccount: {
          accountNumber: formData.accountNumber,
          ifsc: formData.ifsc,
          bankName: formData.bankName,
        },
        commissionRatePercent: Number(formData.commissionRatePercent),
        avgPrepTimeMins: Number(formData.avgPrepTimeMins),
        slaAdherencePercent: Number(formData.slaAdherencePercent),
        isStoreOnline: formData.isStoreOnline,
        canReceiveOrders: formData.canReceiveOrders,
        isOrderingEnabled: formData.isOrderingEnabled,
        status: formData.status,
        suspensionReason: formData.suspensionReason,
        documents: {
          gstVerified: formData.gstVerified,
          panVerified: formData.panVerified,
          bankVerified: formData.bankVerified,
          tradeLicenseVerified: formData.tradeLicenseVerified,
          tradeLicenseNumber: formData.tradeLicenseNumber,
        },
      };

      await adminApi.put(`/api/admin/sellers/${seller.id}`, payload);
      setSuccessMsg('Partner store profile & parameters updated successfully!');
      onRefresh();
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update store details');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSuspendStore = async () => {
    if (!suspendInputReason.trim()) {
      setErrorMsg('Please specify a valid reason for suspending this partner store.');
      return;
    }
    try {
      setIsSubmitting(true);
      setErrorMsg('');
      await adminApi.post(`/api/admin/sellers/${seller.id}/suspend`, { reason: suspendInputReason });
      setFormData((prev) => ({
        ...prev,
        status: 'SUSPENDED',
        isStoreOnline: false,
        canReceiveOrders: false,
        suspensionReason: suspendInputReason,
      }));
      setShowSuspendConfirm(false);
      setSuccessMsg(`Store "${seller.name}" has been suspended.`);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to suspend store');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReactivateStore = async () => {
    try {
      setIsSubmitting(true);
      setErrorMsg('');
      await adminApi.post(`/api/admin/sellers/${seller.id}/reactivate`, {});
      setFormData((prev) => ({
        ...prev,
        status: 'ACTIVE',
        isStoreOnline: true,
        canReceiveOrders: true,
        suspensionReason: '',
      }));
      setSuccessMsg(`Store "${seller.name}" has been reactivated and is now Live.`);
      onRefresh();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to reactivate store');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteStore = async () => {
    try {
      setIsSubmitting(true);
      setErrorMsg('');
      await adminApi.delete(`/api/admin/sellers/${seller.id}`);
      onRefresh();
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to delete partner store');
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 my-auto max-h-[92vh] flex flex-col">
        {/* Modal Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-[#009DE0] text-white flex items-center justify-center font-bold shadow-xs">
              <Store className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-900">{formData.name}</h2>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    formData.status === 'ACTIVE'
                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                      : formData.status === 'SUSPENDED'
                      ? 'bg-rose-100 text-rose-800 border border-rose-200'
                      : formData.status === 'PENDING_APPROVAL'
                      ? 'bg-indigo-100 text-indigo-800 border border-indigo-200'
                      : 'bg-slate-200 text-slate-700'
                  }`}
                >
                  {formData.status}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Full Store Management, Operation Controls & KYC Parameters (ID: <span className="font-mono text-slate-700 font-medium">{seller.id}</span>)
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-900 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Status Alerts */}
        {(errorMsg || successMsg) && (
          <div className="px-6 pt-3 shrink-0">
            {errorMsg && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}
            {successMsg && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-xs flex items-center gap-2 font-medium">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{successMsg}</span>
              </div>
            )}
          </div>
        )}

        {/* Tab Navigation */}
        <div className="px-6 pt-3 border-b border-slate-200 bg-white flex items-center gap-1 overflow-x-auto shrink-0 scrollbar-none">
          <button
            onClick={() => setActiveTab('IDENTITY')}
            className={`px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'IDENTITY'
                ? 'border-emerald-600 text-emerald-700 bg-emerald-50/50'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Store className="h-3.5 w-3.5" />
            <span>Identity & Location</span>
          </button>
          <button
            onClick={() => setActiveTab('OPERATIONS')}
            className={`px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'OPERATIONS'
                ? 'border-emerald-600 text-emerald-700 bg-emerald-50/50'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Sliders className="h-3.5 w-3.5" />
            <span>Operations & SLA</span>
          </button>
          <button
            onClick={() => setActiveTab('KYC')}
            className={`px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'KYC'
                ? 'border-emerald-600 text-emerald-700 bg-emerald-50/50'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>KYC & Statutory</span>
          </button>
          <button
            onClick={() => setActiveTab('COMMERCIALS')}
            className={`px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'COMMERCIALS'
                ? 'border-emerald-600 text-emerald-700 bg-emerald-50/50'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Percent className="h-3.5 w-3.5" />
            <span>Commission & Payout</span>
          </button>
          <button
            onClick={() => setActiveTab('EARNINGS')}
            className={`px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'EARNINGS'
                ? 'border-indigo-600 text-indigo-700 bg-indigo-50/50'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <TrendingUp className="h-3.5 w-3.5" />
            <span>Sales & Earnings Dashboard</span>
          </button>
          <button
            onClick={() => setActiveTab('ENFORCEMENT')}
            className={`px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 transition-all flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'ENFORCEMENT'
                ? 'border-rose-600 text-rose-700 bg-rose-50/50'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Ban className="h-3.5 w-3.5" />
            <span>Status & Actions</span>
          </button>
        </div>

        {/* Modal Main Content Container */}
        <div className="p-6 overflow-y-auto space-y-5 text-xs text-slate-700 grow">
          {/* TAB 1: STORE IDENTITY & LOCATION */}
          {activeTab === 'IDENTITY' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Store Name *</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    placeholder="e.g. Koramangala Hardware Mart"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Proprietor / Owner Name *</label>
                  <input
                    type="text"
                    value={formData.ownerName}
                    onChange={(e) => setFormData({ ...formData, ownerName: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    placeholder="e.g. Rajesh Kumar Sharma"
                  />
                </div>

                <div className="col-span-1 md:col-span-2">
                  <StoreCategorySelector
                    selectedCategories={formData.categories}
                    onChange={(cats) => setFormData({ ...formData, categories: cats })}
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Operating City / Region</label>
                  <select
                    value={formData.cityId}
                    onChange={(e) => setFormData({ ...formData, cityId: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="bengaluru">Bengaluru (Karnataka)</option>
                    <option value="mumbai">Mumbai & MMR (Maharashtra)</option>
                    <option value="delhi_ncr">Delhi NCR (Delhi / UP / Haryana)</option>
                    <option value="hyderabad">Hyderabad (Telangana)</option>
                    <option value="chennai">Chennai (Tamil Nadu)</option>
                    <option value="pune">Pune (Maharashtra)</option>
                    <option value="kolkata">Kolkata (West Bengal)</option>
                    <option value="ahmedabad">Ahmedabad (Gujarat)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Contact Phone Number *</label>
                  <input
                    type="text"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    placeholder="+91 98450 12345"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Official Email Address</label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    placeholder="merchant@qcom-sellers.in"
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Cluster / Operating Area Name</label>
                  <input
                    type="text"
                    value={formData.areaName}
                    onChange={(e) => setFormData({ ...formData, areaName: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    placeholder="e.g. Koramangala 4th Block, Bengaluru"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-slate-700 font-semibold mb-1">Full Physical Store Address</label>
                  <textarea
                    rows={2}
                    value={formData.address}
                    onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    placeholder="Plot 14, 80 Feet Road, Koramangala, Bengaluru 560034"
                  />
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: OPERATIONS & SLA */}
          {activeTab === 'OPERATIONS' && (
            <div className="space-y-4">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                <h3 className="font-bold text-slate-900 uppercase tracking-wider text-[11px] flex items-center gap-2">
                  <Sliders className="h-4 w-4 text-emerald-600" />
                  Live Operational Controls
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                  <div className="p-3 bg-white rounded-lg border border-slate-200 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-900 block">Store Availability</span>
                      <span className="text-[11px] text-slate-500">Live on Customer App</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, isStoreOnline: !formData.isStoreOnline })}
                      className={`px-3 py-1 rounded text-xs font-bold transition-all ${
                        formData.isStoreOnline ? 'bg-emerald-600 text-white' : 'bg-slate-300 text-slate-700'
                      }`}
                    >
                      {formData.isStoreOnline ? 'ONLINE' : 'OFFLINE'}
                    </button>
                  </div>

                  <div className="p-3 bg-white rounded-lg border border-slate-200 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-900 block">Receive Orders</span>
                      <span className="text-[11px] text-slate-500">Order Dispatch Queue</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, canReceiveOrders: !formData.canReceiveOrders })}
                      className={`px-3 py-1 rounded text-xs font-bold transition-all ${
                        formData.canReceiveOrders ? 'bg-sky-600 text-white' : 'bg-slate-300 text-slate-700'
                      }`}
                    >
                      {formData.canReceiveOrders ? 'ENABLED' : 'PAUSED'}
                    </button>
                  </div>

                  <div className="p-3 bg-white rounded-lg border border-slate-200 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-900 block">Ordering System</span>
                      <span className="text-[11px] text-slate-500">Checkout Accept</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, isOrderingEnabled: !formData.isOrderingEnabled })}
                      className={`px-3 py-1 rounded text-xs font-bold transition-all ${
                        formData.isOrderingEnabled ? 'bg-indigo-600 text-white' : 'bg-slate-300 text-slate-700'
                      }`}
                    >
                      {formData.isOrderingEnabled ? 'ACTIVE' : 'BLOCKED'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1 flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-slate-500" />
                    Target Prep Time (Minutes)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.5"
                    max="30"
                    value={formData.avgPrepTimeMins}
                    onChange={(e) => setFormData({ ...formData, avgPrepTimeMins: Number(e.target.value) })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-bold focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">Average prep SLA expected from partner store staff.</p>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <TrendingUp className="h-3.5 w-3.5 text-slate-500" />
                      Live SLA Adherence Score
                    </span>
                    <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100/80 px-2 py-0.5 rounded-md uppercase tracking-wider">
                      Auto-Computed
                    </span>
                  </label>
                  <div className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 flex items-center justify-between">
                    <div className="flex items-baseline gap-2">
                      <span className="text-lg font-bold text-slate-900 font-mono">
                        {seller.slaAdherencePercent ?? 98.4}%
                      </span>
                      <span className="text-[11px] font-bold text-emerald-600">
                        {(seller.slaAdherencePercent ?? 98.4) >= 95 ? 'Optimal SLA (≥95%)' : 'Monitored SLA'}
                      </span>
                    </div>
                    <span className="text-[10px] font-medium text-slate-500 bg-white border border-slate-200 px-2 py-1 rounded">
                      Standard: ≤ 5 mins
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">
                    System-generated based on % of orders prepared & dispatched within the 5-min SLA.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: KYC & STATUTORY */}
          {activeTab === 'KYC' && (
            <div className="space-y-4">
              <div className="p-3 bg-indigo-50/80 border border-indigo-200/80 rounded-xl flex items-center justify-between text-indigo-950">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-indigo-600 shrink-0" />
                  <div>
                    <span className="font-bold text-xs block">Merchant Compliance & Document Audit</span>
                    <span className="text-[11px] text-indigo-800">Review or override statutory verifications directly.</span>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {/* GSTIN Row */}
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="grow space-y-1">
                    <label className="font-bold text-slate-900 block">GSTIN Registration Number</label>
                    <input
                      type="text"
                      value={formData.gstin}
                      onChange={(e) => setFormData({ ...formData, gstin: e.target.value })}
                      className="w-full sm:w-64 bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono font-bold uppercase focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, gstVerified: !formData.gstVerified })}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 shrink-0 transition-all ${
                      formData.gstVerified
                        ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                        : 'bg-amber-100 text-amber-800 border border-amber-300'
                    }`}
                  >
                    {formData.gstVerified ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                    <span>{formData.gstVerified ? 'VERIFIED' : 'PENDING / REJECTED'}</span>
                  </button>
                </div>

                {/* PAN Row */}
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="grow space-y-1">
                    <label className="font-bold text-slate-900 block">PAN Number (Proprietor / Firm)</label>
                    <input
                      type="text"
                      value={formData.panNumber}
                      onChange={(e) => setFormData({ ...formData, panNumber: e.target.value })}
                      className="w-full sm:w-64 bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono font-bold uppercase focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, panVerified: !formData.panVerified })}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 shrink-0 transition-all ${
                      formData.panVerified
                        ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                        : 'bg-amber-100 text-amber-800 border border-amber-300'
                    }`}
                  >
                    {formData.panVerified ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                    <span>{formData.panVerified ? 'VERIFIED' : 'PENDING / REJECTED'}</span>
                  </button>
                </div>

                {/* Bank Account Row */}
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900">Settlement Bank Account Details</span>
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, bankVerified: !formData.bankVerified })}
                      className={`px-3 py-1 rounded-lg text-xs font-bold flex items-center gap-1.5 shrink-0 transition-all ${
                        formData.bankVerified
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : 'bg-amber-100 text-amber-800 border border-amber-300'
                      }`}
                    >
                      {formData.bankVerified ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                      <span>{formData.bankVerified ? 'BANK VERIFIED' : 'PENDING VERIFICATION'}</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-slate-600 text-[11px] mb-0.5">Account Number</label>
                      <input
                        type="text"
                        value={formData.accountNumber}
                        onChange={(e) => setFormData({ ...formData, accountNumber: e.target.value })}
                        className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500 text-xs"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-600 text-[11px] mb-0.5">IFSC Code</label>
                      <input
                        type="text"
                        value={formData.ifsc}
                        onChange={(e) => setFormData({ ...formData, ifsc: e.target.value.toUpperCase() })}
                        className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono font-bold focus:outline-none focus:ring-1 focus:ring-emerald-500 text-xs"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-600 text-[11px] mb-0.5">Bank Name & Branch</label>
                      <input
                        type="text"
                        value={formData.bankName}
                        onChange={(e) => setFormData({ ...formData, bankName: e.target.value })}
                        className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 focus:outline-none focus:ring-1 focus:ring-emerald-500 text-xs"
                      />
                    </div>
                  </div>
                </div>

                {/* Trade License Row */}
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="grow space-y-1">
                    <label className="font-bold text-slate-900 block">BBMP / Shop Act Trade License Certificate</label>
                    <input
                      type="text"
                      value={formData.tradeLicenseNumber}
                      onChange={(e) => setFormData({ ...formData, tradeLicenseNumber: e.target.value })}
                      className="w-full sm:w-64 bg-white border border-slate-300 rounded px-2 py-1 text-slate-900 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, tradeLicenseVerified: !formData.tradeLicenseVerified })}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 shrink-0 transition-all ${
                      formData.tradeLicenseVerified
                        ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                        : 'bg-amber-100 text-amber-800 border border-amber-300'
                    }`}
                  >
                    {formData.tradeLicenseVerified ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                    <span>{formData.tradeLicenseVerified ? 'VERIFIED' : 'PENDING / REJECTED'}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: COMMERCIALS & PAYOUT */}
          {activeTab === 'COMMERCIALS' && (
            <div className="space-y-4">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                <h3 className="font-bold text-slate-900 uppercase tracking-wider text-[11px] flex items-center gap-2">
                  <Percent className="h-4 w-4 text-emerald-600" />
                  Marketplace Commission & Settlement Rates
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Marketplace Commission Rate (%)</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        step="0.1"
                        min="15"
                        max="50"
                        value={formData.commissionRatePercent}
                        onChange={(e) => setFormData({ ...formData, commissionRatePercent: Number(e.target.value) })}
                        className="w-full bg-white border border-slate-300 rounded-lg p-2 text-slate-900 font-bold text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500"
                      />
                      <span className="text-slate-500 font-bold text-sm">%</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">Platform deduction percent on gross seller order volume (min 15.0%).</p>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Automated Payout Cycle</label>
                    <select
                      className="w-full bg-white border border-slate-300 rounded-lg p-2 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    >
                      <option value="T+1_DAILY">T+1 Daily Automated NEFT/RTGS</option>
                      <option value="WEEKLY_MONDAY">Weekly Settlement (Mondays)</option>
                      <option value="BI_WEEKLY">Bi-Weekly Settlement</option>
                    </select>
                    <p className="text-[11px] text-slate-500 mt-1">Direct bank clearance SLA timeline.</p>
                  </div>
                </div>
              </div>

              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl space-y-2 text-emerald-950">
                <h4 className="font-bold text-xs flex items-center gap-1.5">
                  <CreditCard className="h-4 w-4 text-emerald-700" />
                  Active Settlement Mandate
                </h4>
                <div className="text-xs space-y-0.5 font-mono text-emerald-900">
                  <div>Account: <strong className="font-sans text-slate-900">{formData.accountNumber || 'N/A'}</strong></div>
                  <div>IFSC: <strong className="font-sans text-slate-900">{formData.ifsc || 'N/A'}</strong></div>
                  <div>Bank: <strong className="font-sans text-slate-900">{formData.bankName || 'N/A'}</strong></div>
                </div>
              </div>
            </div>
          )}

          {/* TAB: SALES & EARNINGS BREAKDOWN */}
          {activeTab === 'EARNINGS' && (
            <div className="space-y-4">
              <SellerEarningsBreakdown
                seller={{
                  ...seller,
                  commissionRatePercent: Number(formData.commissionRatePercent),
                }}
              />
            </div>
          )}

          {/* TAB 5: STATUS & ENFORCEMENT */}
          {activeTab === 'ENFORCEMENT' && (
            <div className="space-y-4">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                <h3 className="font-bold text-slate-900 uppercase tracking-wider text-[11px] flex items-center gap-2">
                  <Ban className="h-4 w-4 text-rose-600" />
                  Store Status Controls & Administrative Enforcement
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Authoritative Store Status</label>
                    <select
                      value={formData.status}
                      onChange={(e) => setFormData({ ...formData, status: e.target.value as any })}
                      className="w-full bg-white border border-slate-300 rounded-lg p-2 text-slate-900 font-bold focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    >
                      <option value="ACTIVE">ACTIVE (Store Live)</option>
                      <option value="SUSPENDED">SUSPENDED (Ops Paused)</option>
                      <option value="PENDING_APPROVAL">PENDING_APPROVAL (KYC Audit)</option>
                      <option value="REJECTED">REJECTED (Application Denied)</option>
                    </select>
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block text-slate-800 font-bold mb-1 text-xs flex items-center gap-0.5">
                      <span>Reason for Status Change</span>
                      <span className="text-rose-600 font-bold text-sm">*</span>
                    </label>
                    <textarea
                      rows={2}
                      required
                      value={formData.suspensionReason}
                      onChange={(e) => setFormData({ ...formData, suspensionReason: e.target.value })}
                      className="w-full bg-white border border-slate-300 rounded-lg p-2.5 text-xs text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-slate-900"
                      placeholder="Provide required justification reason for store status change..."
                    />
                  </div>
                </div>
              </div>

              {/* Action Buttons for Suspend / Reactivate / Delete */}
              <div className="p-4 bg-rose-50/60 border border-rose-200 rounded-xl space-y-4">
                <h4 className="font-bold text-rose-900 text-xs uppercase tracking-wider">High Impact Controls</h4>

                <div className="flex flex-wrap items-center gap-3">
                  {formData.status === 'SUSPENDED' ? (
                    <button
                      type="button"
                      onClick={handleReactivateStore}
                      disabled={isSubmitting || !canSuspend}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition-all shadow-xs"
                    >
                      <RotateCcw className="h-4 w-4" />
                      <span>Reactivate Store & Lift Suspension</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowSuspendConfirm(true)}
                      disabled={isSubmitting || !canSuspend}
                      className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition-all shadow-xs"
                    >
                      <Ban className="h-4 w-4" />
                      <span>Suspend Store Operations</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(true)}
                    disabled={isSubmitting || !canEdit}
                    className="px-4 py-2 bg-slate-100 hover:bg-rose-100 text-rose-700 border border-slate-300 hover:border-rose-300 font-bold rounded-xl text-xs flex items-center gap-1.5 transition-all"
                  >
                    <Trash2 className="h-4 w-4" />
                    <span>De-board & Delete Partner Store</span>
                  </button>
                </div>
              </div>

              {/* Suspend Confirmation Drawer */}
              {showSuspendConfirm && (
                <div className="p-4 bg-rose-100 border border-rose-300 rounded-xl space-y-3 animate-in fade-in">
                  <h4 className="font-bold text-rose-900 text-xs">Confirm Store Suspension</h4>
                  <p className="text-[11px] text-rose-800">
                    Suspending this store will immediately set its availability to Offline, pause order reception, and prevent customers from placing orders.
                  </p>
                  <label className="block text-rose-900 font-bold text-xs flex items-center gap-0.5">
                    <span>Reason for Status Change (Suspension)</span>
                    <span className="text-rose-600 font-bold text-sm">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={suspendInputReason}
                    onChange={(e) => setSuspendInputReason(e.target.value)}
                    className="w-full bg-white border border-rose-300 rounded-lg p-2.5 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-rose-500 text-xs"
                    placeholder="Provide detailed reason for suspension..."
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowSuspendConfirm(false)}
                      className="px-3 py-1 bg-white border border-slate-300 text-slate-700 font-semibold rounded-lg text-xs"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSuspendStore}
                      disabled={isSubmitting}
                      className="px-4 py-1.5 bg-rose-700 hover:bg-rose-800 text-white font-bold rounded-lg text-xs"
                    >
                      Confirm Suspension
                    </button>
                  </div>
                </div>
              )}

              {/* Delete Confirmation Drawer */}
              {showDeleteConfirm && (
                <div className="p-4 bg-slate-900 text-white rounded-xl space-y-3 animate-in fade-in">
                  <h4 className="font-bold text-amber-400 text-xs flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4" />
                    Permanent Store Removal
                  </h4>
                  <p className="text-[11px] text-slate-300">
                    Are you sure you want to completely de-board and delete "{seller.name}"? This action will remove the store from active marketplace listings.
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowDeleteConfirm(false)}
                      className="px-3 py-1 bg-slate-800 text-slate-300 font-semibold rounded-lg text-xs hover:bg-slate-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleDeleteStore}
                      disabled={isSubmitting}
                      className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg text-xs"
                    >
                      Delete Store Permanently
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
          <div className="text-xs text-slate-500 font-medium">
            Joined: <span className="text-slate-900 font-bold">{seller.joinedDate}</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 font-bold rounded-xl text-xs transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveAll}
              disabled={isSubmitting || !canEdit}
              className="px-5 py-2 bg-[#009DE0] hover:bg-[#0087c2] text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition-all shadow-xs"
            >
              <Save className="h-4 w-4" />
              <span>Save Store Changes</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

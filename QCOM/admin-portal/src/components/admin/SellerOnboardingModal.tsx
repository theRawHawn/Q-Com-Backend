import React, { useState } from 'react';
import {
  X,
  Store,
  CheckCircle2,
  AlertTriangle,
  Building,
  CreditCard,
  FileText,
  Clock,
  MapPin,
  Percent,
  Plus
} from 'lucide-react';
import { NON_FOOD_GROCERY_CATEGORIES } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';
import { StoreCategorySelector } from './StoreCategorySelector';

interface SellerOnboardingModalProps {
  onClose: () => void;
  onRefresh: () => void;
  canCreate: boolean;
}

export const SellerOnboardingModal: React.FC<SellerOnboardingModalProps> = ({
  onClose,
  onRefresh,
  canCreate,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const [formData, setFormData] = useState({
    name: '',
    ownerName: '',
    hubType: 'General Marketplace Hub',
    categories: ['Electrical & Lighting', 'Hardware & Fasteners'] as string[],
    phone: '',
    email: '',
    cityId: 'bengaluru',
    areaName: '',
    address: '',
    gstin: '',
    panNumber: '',
    accountNumber: '',
    ifsc: '',
    bankName: '',
    commissionRatePercent: 15.0,
    avgPrepTimeMins: 5.0,
    status: 'ACTIVE',
    gstVerified: true,
    panVerified: true,
    bankVerified: true,
    tradeLicenseVerified: true,
    tradeLicenseNumber: 'TL-BBMP-2026-9812',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.ownerName || !formData.phone || !formData.gstin) {
      setErrorMsg('Store Name, Proprietor Name, Phone, and GSTIN are required.');
      return;
    }

    try {
      setIsSubmitting(true);
      setErrorMsg('');

      const payload = {
        name: formData.name,
        ownerName: formData.ownerName,
        hubType: formData.hubType,
        categories: formData.categories,
        phone: formData.phone,
        email: formData.email,
        cityId: formData.cityId,
        areaName: formData.areaName || 'Central Marketplace',
        address: formData.address || `${formData.areaName || 'Central Hub'}, Bengaluru`,
        gstin: formData.gstin.toUpperCase().trim(),
        panNumber: formData.panNumber ? formData.panNumber.toUpperCase().trim() : formData.gstin.substring(2, 12).toUpperCase(),
        bankAccount: {
          accountNumber: formData.accountNumber || '100098273645',
          ifsc: formData.ifsc || 'HDFC0000124',
          bankName: formData.bankName || 'HDFC Bank, Commercial Branch',
        },
        commissionRatePercent: Number(formData.commissionRatePercent),
        avgPrepTimeMins: Number(formData.avgPrepTimeMins),
        status: formData.status,
        documents: {
          gstVerified: formData.gstVerified,
          panVerified: formData.panVerified,
          bankVerified: formData.bankVerified,
          tradeLicenseVerified: formData.tradeLicenseVerified,
          tradeLicenseNumber: formData.tradeLicenseNumber,
        },
      };

      await adminApi.post('/api/admin/sellers/create', payload);
      onRefresh();
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to onboard new partner store');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 my-auto max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="p-5 border-b border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-slate-900 text-white flex items-center justify-center font-bold shadow-xs">
              <Plus className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Onboard New Partner Store</h2>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-900 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-4 text-xs text-slate-700 grow">
          {errorMsg && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Section 1: Business Profile */}
          <div className="space-y-3">
            <h3 className="font-bold text-slate-900 uppercase tracking-wider text-[11px] flex items-center gap-2">
              <Store className="h-4 w-4 text-emerald-600" />
              Store Profile & Identity
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Store Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Whitefield Switchgear Depot"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Proprietor / Owner Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Vikramaditya Rao"
                  value={formData.ownerName}
                  onChange={(e) => setFormData({ ...formData, ownerName: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div className="col-span-1 sm:col-span-2">
                <StoreCategorySelector
                  selectedCategories={formData.categories}
                  onChange={(cats) => setFormData({ ...formData, categories: cats })}
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Operating City</label>
                <select
                  value={formData.cityId}
                  onChange={(e) => setFormData({ ...formData, cityId: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-slate-900"
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
                  required
                  placeholder="+91 98450 99887"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Official Email Address</label>
                <input
                  type="email"
                  placeholder="contact@store.in"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Operating Area Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. ITPL Main Road, Whitefield"
                  value={formData.areaName}
                  onChange={(e) => setFormData({ ...formData, areaName: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Full Physical Address</label>
                <input
                  type="text"
                  placeholder="Plot 88, ITPL Main Rd, Bengaluru 560066"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-medium focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>
            </div>
          </div>

          {/* Section 2: Legal GSTIN & KYC */}
          <div className="space-y-3 pt-2 border-t border-slate-200">
            <h3 className="font-bold text-slate-900 uppercase tracking-wider text-[11px] flex items-center gap-2">
              <FileText className="h-4 w-4 text-emerald-600" />
              Statutory GSTIN & Bank Details
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">GSTIN Number *</label>
                <input
                  type="text"
                  required
                  placeholder="29AAACG1234H1Z5"
                  value={formData.gstin}
                  onChange={(e) => setFormData({ ...formData, gstin: e.target.value.toUpperCase() })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-mono font-bold uppercase focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">PAN Number</label>
                <input
                  type="text"
                  placeholder="AAACG1234H"
                  value={formData.panNumber}
                  onChange={(e) => setFormData({ ...formData, panNumber: e.target.value.toUpperCase() })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-mono font-bold uppercase focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Bank Account Number</label>
                <input
                  type="text"
                  placeholder="501002938475"
                  value={formData.accountNumber}
                  onChange={(e) => setFormData({ ...formData, accountNumber: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-mono focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Bank IFSC Code</label>
                <input
                  type="text"
                  placeholder="HDFC0000124"
                  value={formData.ifsc}
                  onChange={(e) => setFormData({ ...formData, ifsc: e.target.value.toUpperCase() })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-mono font-bold uppercase focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>
            </div>
          </div>

          {/* Section 3: Commercials & Status */}
          <div className="space-y-3 pt-2 border-t border-slate-200">
            <h3 className="font-bold text-slate-900 uppercase tracking-wider text-[11px] flex items-center gap-2">
              <Percent className="h-4 w-4 text-emerald-600" />
              Commission Rate & Status
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-slate-700 font-semibold mb-1">Marketplace Commission % (Min 15%)</label>
                <input
                  type="number"
                  step="0.1"
                  min="15"
                  max="50"
                  value={formData.commissionRatePercent}
                  onChange={(e) => setFormData({ ...formData, commissionRatePercent: Number(e.target.value) })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-bold focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Avg Prep Time (mins)</label>
                <input
                  type="number"
                  step="0.1"
                  min="0.5"
                  max="30"
                  value={formData.avgPrepTimeMins}
                  onChange={(e) => setFormData({ ...formData, avgPrepTimeMins: Number(e.target.value) })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-bold focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Initial Status</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-slate-900 font-bold focus:outline-none focus:ring-1 focus:ring-slate-900"
                >
                  <option value="ACTIVE">ACTIVE (Store Live)</option>
                  <option value="PENDING_APPROVAL">PENDING_APPROVAL (KYC Audit)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Footer Submit */}
          <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 font-bold rounded-xl text-xs transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !canCreate}
              className="px-5 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition-all shadow-xs"
            >
              <Plus className="h-4 w-4" />
              <span>Onboard Partner Store</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

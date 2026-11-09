import React, { useState, useEffect } from 'react';
import {
  Percent,
  Plus,
  Search,
  RefreshCw,
  Tag,
  CheckCircle2,
  AlertCircle,
  ToggleLeft,
  ToggleRight,
  IndianRupee,
  Building2,
  Sliders,
  Calendar,
  X,
  Edit2,
  Trash2,
  Eye,
  PauseCircle,
  PlayCircle
} from 'lucide-react';
import { AdminPromotion } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

export const PromotionsManager: React.FC = () => {
  const [promotions, setPromotions] = useState<AdminPromotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'PAUSED'>('ALL');
  
  // Modals state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingPromo, setEditingPromo] = useState<AdminPromotion | null>(null);
  const [selectedPromoForDetail, setSelectedPromoForDetail] = useState<AdminPromotion | null>(null);
  const [deletingPromoId, setDeletingPromoId] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);

  // Form state for Create & Edit
  const [formData, setFormData] = useState({
    code: '',
    name: '',
    type: 'COUPON' as const,
    discountValue: 15,
    isPercentage: true,
    minOrderValue: 499,
    maxDiscountCap: 300,
    fundingSource: 'PLATFORM' as 'PLATFORM' | 'BRAND' | 'SELLER' | 'SHARED',
    applicableCategory: 'All Categories',
    validUntil: '2026-12-31',
    maxUsageLimit: 1000,
  });

  const fetchPromotions = async () => {
    try {
      setLoading(true);
      const res: any = await adminApi.get('/api/admin/promotions');
      if (res.success) {
        setPromotions(res.promotions || []);
      }
    } catch (err) {
      console.error('Failed to load promotions:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPromotions();
  }, []);

  const handleToggleStatus = async (id: string) => {
    try {
      const res: any = await adminApi.post(`/api/admin/promotions/${id}/toggle`, {});
      if (res.success) {
        setPromotions((prev) =>
          prev.map((p) => (p.id === id ? { ...p, status: res.promotion.status } : p))
        );
      }
    } catch (err) {
      console.error('Failed to toggle promotion:', err);
    }
  };

  const openCreateModal = () => {
    setEditingPromo(null);
    setFormData({
      code: '',
      name: '',
      type: 'COUPON',
      discountValue: 15,
      isPercentage: true,
      minOrderValue: 499,
      maxDiscountCap: 300,
      fundingSource: 'PLATFORM',
      applicableCategory: 'All Categories',
      validUntil: '2026-12-31',
      maxUsageLimit: 1000,
    });
    setIsCreateModalOpen(true);
  };

  const openEditModal = (promo: AdminPromotion) => {
    setEditingPromo(promo);
    setFormData({
      code: promo.code,
      name: promo.name,
      type: promo.type || 'COUPON',
      discountValue: promo.discountValue,
      isPercentage: promo.isPercentage,
      minOrderValue: promo.minOrderValue,
      maxDiscountCap: promo.maxDiscountCap,
      fundingSource: promo.fundingSource as any,
      applicableCategory: promo.applicableCategory || 'All Categories',
      validUntil: promo.validUntil,
      maxUsageLimit: promo.maxUsageLimit || 1000,
    });
    setIsCreateModalOpen(true);
  };

  const handleSavePromotion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.code || !formData.name) return;

    try {
      setSaving(true);
      if (editingPromo) {
        // Edit flow
        const res: any = await adminApi.post(`/api/admin/promotions/${editingPromo.id}/update`, formData);
        if (res.success) {
          setPromotions((prev) =>
            prev.map((p) => (p.id === editingPromo.id ? res.promotion : p))
          );
          setIsCreateModalOpen(false);
          setEditingPromo(null);
        }
      } else {
        // Create flow
        const res: any = await adminApi.post('/api/admin/promotions/create', formData);
        if (res.success) {
          setPromotions((prev) => [res.promotion, ...prev]);
          setIsCreateModalOpen(false);
        }
      }
    } catch (err) {
      console.error('Failed to save promotion:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePromotion = async (id: string) => {
    try {
      setSaving(true);
      const res: any = await adminApi.delete(`/api/admin/promotions/${id}`);
      if (res.success) {
        setPromotions((prev) => prev.filter((p) => p.id !== id));
        setDeletingPromoId(null);
      }
    } catch (err) {
      console.error('Failed to delete promotion:', err);
    } finally {
      setSaving(false);
    }
  };

  const filteredPromotions = promotions.filter((p) => {
    const matchesSearch =
      p.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.fundingSource.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.applicableCategory && p.applicableCategory.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesStatus = statusFilter === 'ALL' || p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Promotions & Coupons
          </h1>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            onClick={openCreateModal}
            className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 rounded-md text-xs font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-colors cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Create Promo Coupon</span>
          </button>

          <button
            onClick={fetchPromotions}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200/90 transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)] cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#009DE0]' : 'text-slate-500'}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Filters & Search Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by promo code, campaign title, funding model or category..."
            className="w-full pl-9 pr-4 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
          />
        </div>

        <div className="flex items-center gap-1.5 text-xs">
          <button
            onClick={() => setStatusFilter('ALL')}
            className={`px-3 py-1 rounded-lg font-medium transition-colors ${
              statusFilter === 'ALL' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            All
          </button>
          <button
            onClick={() => setStatusFilter('ACTIVE')}
            className={`px-3 py-1 rounded-lg font-medium transition-colors ${
              statusFilter === 'ACTIVE' ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Active
          </button>
          <button
            onClick={() => setStatusFilter('PAUSED')}
            className={`px-3 py-1 rounded-lg font-medium transition-colors ${
              statusFilter === 'PAUSED' ? 'bg-amber-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Paused
          </button>
        </div>
      </div>

      {/* Promotions Table */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-2xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3">Coupon Code & Title</th>
                <th className="px-4 py-3">Discount Details</th>
                <th className="px-4 py-3">Funding Model</th>
                <th className="px-4 py-3">Thresholds</th>
                <th className="px-4 py-3">Redemptions</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions & Controls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    <RefreshCw className="h-5 w-5 animate-spin mx-auto text-[#009DE0] mb-2" />
                    Loading promotions...
                  </td>
                </tr>
              ) : filteredPromotions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    No promotions found matching filters.
                  </td>
                </tr>
              ) : (
                filteredPromotions.map((promo) => (
                  <tr key={promo.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-4 py-3.5">
                      <div className="font-bold font-mono text-sm text-[#00608a] bg-sky-50 px-2 py-0.5 rounded border border-sky-200/70 inline-block mb-1">
                        {promo.code}
                      </div>
                      <div className="text-slate-700 font-medium">{promo.name}</div>
                      <div className="text-[11px] text-slate-400">Valid till {promo.validUntil}</div>
                    </td>

                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">
                        {promo.isPercentage ? `${promo.discountValue}% OFF` : `₹${promo.discountValue} FLAT`}
                      </div>
                      <div className="text-[11px] text-slate-500">Max Cap: ₹{promo.maxDiscountCap}</div>
                    </td>

                    <td className="px-4 py-3.5">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-700 border border-slate-200">
                        <Building2 className="h-3 w-3 text-slate-500" />
                        {promo.fundingSource} Funded
                      </span>
                      {promo.applicableCategory && (
                        <div className="text-[11px] text-slate-400 mt-1">{promo.applicableCategory}</div>
                      )}
                    </td>

                    <td className="px-4 py-3.5">
                      <div className="text-slate-800 font-medium">Min ₹{promo.minOrderValue}</div>
                      <div className="text-[11px] text-slate-400">Target: Verified Trade</div>
                    </td>

                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-slate-900">{promo.usageCount || 0} / {promo.maxUsageLimit}</div>
                      <div className="w-20 bg-slate-100 rounded-full h-1.5 mt-1 overflow-hidden">
                        <div
                          className="bg-[#009DE0] h-full rounded-full"
                          style={{ width: `${Math.min(100, ((promo.usageCount || 0) / promo.maxUsageLimit) * 100)}%` }}
                        />
                      </div>
                    </td>

                    <td className="px-4 py-3.5">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                          promo.status === 'ACTIVE'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-amber-50 text-amber-700 border border-amber-200'
                        }`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${promo.status === 'ACTIVE' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                        {promo.status}
                      </span>
                    </td>

                    <td className="px-4 py-3.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => setSelectedPromoForDetail(promo)}
                          title="View Details"
                          className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>

                        <button
                          onClick={() => openEditModal(promo)}
                          title="Edit Promotion"
                          className="p-1.5 text-slate-500 hover:text-[#009DE0] hover:bg-sky-50 rounded-lg transition-colors"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>

                        <button
                          onClick={() => handleToggleStatus(promo.id)}
                          className={`text-[11px] px-2.5 py-1 rounded font-medium border transition-colors ${
                            promo.status === 'ACTIVE'
                              ? 'border-amber-200 text-amber-700 hover:bg-amber-50'
                              : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                          }`}
                        >
                          {promo.status === 'ACTIVE' ? 'Pause' : 'Activate'}
                        </button>

                        <button
                          onClick={() => setDeletingPromoId(promo.id)}
                          title="Delete Promotion"
                          className="p-1.5 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit Promotion Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg max-h-[90vh] sm:max-h-[85vh] flex flex-col my-auto overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0 bg-white">
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Tag className="h-4 w-4 text-[#009DE0]" />
                {editingPromo ? `Edit Promo Code: ${editingPromo.code}` : 'Create New Promo Code'}
              </h2>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1 hover:bg-slate-100 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSavePromotion} className="flex-1 flex flex-col min-h-0 overflow-hidden text-xs">
              <div className="p-6 space-y-4 overflow-y-auto flex-1">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Coupon Code *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. ELEC20"
                      value={formData.code}
                      onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg font-mono font-bold text-[#00608a] focus:outline-none focus:ring-1 focus:ring-[#009DE0] uppercase"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Campaign Title *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Electrician Mega Launch"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Discount Type</label>
                    <select
                      value={formData.isPercentage ? 'PCT' : 'FLAT'}
                      onChange={(e) => setFormData({ ...formData, isPercentage: e.target.value === 'PCT' })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
                    >
                      <option value="PCT">Percentage (%)</option>
                      <option value="FLAT">Flat (₹)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Discount Value *</label>
                    <input
                      type="number"
                      required
                      value={formData.discountValue}
                      onChange={(e) => setFormData({ ...formData, discountValue: Number(e.target.value) })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Max Cap (₹)</label>
                    <input
                      type="number"
                      value={formData.maxDiscountCap}
                      onChange={(e) => setFormData({ ...formData, maxDiscountCap: Number(e.target.value) })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Min Order Value (₹)</label>
                    <input
                      type="number"
                      value={formData.minOrderValue}
                      onChange={(e) => setFormData({ ...formData, minOrderValue: Number(e.target.value) })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Funding Source</label>
                    <select
                      value={formData.fundingSource}
                      onChange={(e) => setFormData({ ...formData, fundingSource: e.target.value as any })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
                    >
                      <option value="PLATFORM">Platform Funded (100%)</option>
                      <option value="BRAND">Brand Co-Funded</option>
                      <option value="SELLER">Seller Merchant Funded</option>
                      <option value="SHARED">Shared 50/50</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Applicable Category</label>
                    <input
                      type="text"
                      value={formData.applicableCategory}
                      onChange={(e) => setFormData({ ...formData, applicableCategory: e.target.value })}
                      placeholder="e.g. Electrical, Plumbing or All"
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Max Redemptions Limit</label>
                    <input
                      type="number"
                      value={formData.maxUsageLimit}
                      onChange={(e) => setFormData({ ...formData, maxUsageLimit: Number(e.target.value) })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Valid Until Date</label>
                  <input
                    type="date"
                    value={formData.validUntil}
                    onChange={(e) => setFormData({ ...formData, validUntil: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0] font-mono"
                  />
                </div>
              </div>

              <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-lg font-medium text-slate-700 hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-[#009DE0] hover:bg-[#0087c2] text-white rounded-lg font-semibold shadow-xs transition-colors"
                >
                  {saving ? 'Saving...' : editingPromo ? 'Update Promo' : 'Create Promo'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Promotion Detail Modal */}
      {selectedPromoForDetail && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200 p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div>
                <span className="font-mono font-bold text-sm text-[#00608a] bg-sky-50 px-2.5 py-1 rounded border border-sky-200">
                  {selectedPromoForDetail.code}
                </span>
                <h3 className="font-bold text-slate-900 text-base mt-2">{selectedPromoForDetail.name}</h3>
              </div>
              <button
                onClick={() => setSelectedPromoForDetail(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-2 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
              <div className="flex justify-between">
                <span className="text-slate-500">Discount:</span>
                <span className="font-bold text-slate-900">
                  {selectedPromoForDetail.isPercentage ? `${selectedPromoForDetail.discountValue}% OFF` : `₹${selectedPromoForDetail.discountValue} FLAT`}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Max Discount Cap:</span>
                <span className="font-bold text-slate-900">₹{selectedPromoForDetail.maxDiscountCap}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Min Order Value:</span>
                <span className="font-bold text-slate-900">₹{selectedPromoForDetail.minOrderValue}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Funding Model:</span>
                <span className="font-bold text-purple-700">{selectedPromoForDetail.fundingSource} Funded</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Redemptions Used:</span>
                <span className="font-bold text-[#00608a]">{selectedPromoForDetail.usageCount} / {selectedPromoForDetail.maxUsageLimit}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Valid Until:</span>
                <span className="font-mono text-slate-800">{selectedPromoForDetail.validUntil}</span>
              </div>
              {selectedPromoForDetail.createdBy && (
                <div className="flex justify-between pt-2 border-t border-slate-200">
                  <span className="text-slate-500">Configured By:</span>
                  <span className="font-medium text-slate-700">{selectedPromoForDetail.createdBy}</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => {
                  const p = selectedPromoForDetail;
                  setSelectedPromoForDetail(null);
                  openEditModal(p);
                }}
                className="px-3 py-1.5 bg-[#009DE0] hover:bg-[#0087c2] text-white rounded-lg font-semibold flex items-center gap-1.5"
              >
                <Edit2 className="h-3.5 w-3.5" />
                Edit Configuration
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingPromoId && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-sm overflow-hidden p-6 space-y-4 text-xs">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="p-2 bg-rose-50 rounded-xl">
                <AlertCircle className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-slate-900">Delete Promo Coupon?</h3>
                <p className="text-slate-500 text-[11px]">This action cannot be undone. Active checkout sessions with this promo code will be affected.</p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => setDeletingPromoId(null)}
                className="px-3 py-1.5 border border-slate-200 rounded-lg text-slate-700 font-medium hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeletePromotion(deletingPromoId)}
                disabled={saving}
                className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg font-semibold shadow-xs"
              >
                {saving ? 'Deleting...' : 'Delete Coupon'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

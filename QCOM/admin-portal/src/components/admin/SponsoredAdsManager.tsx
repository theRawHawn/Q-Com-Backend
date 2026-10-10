import React, { useState, useEffect } from 'react';
import {
  Megaphone,
  Plus,
  Search,
  RefreshCw,
  TrendingUp,
  Eye,
  MousePointer,
  MousePointerClick,
  IndianRupee,
  CheckCircle2,
  AlertTriangle,
  X,
  Sliders,
  ExternalLink,
  Target,
  Edit2,
  Trash2,
  PauseCircle,
  PlayCircle
} from 'lucide-react';
import { SponsoredAdCampaign, AdPlacement } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

export const SponsoredAdsManager: React.FC = () => {
  const [campaigns, setCampaigns] = useState<SponsoredAdCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'LIVE' | 'PENDING_APPROVAL' | 'PAUSED'>('ALL');
  
  // Modals state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<SponsoredAdCampaign | null>(null);
  const [selectedCampaignForDetail, setSelectedCampaignForDetail] = useState<SponsoredAdCampaign | null>(null);
  const [deletingCampaignId, setDeletingCampaignId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    campaignName: '',
    advertiserBrand: '',
    brandContactEmail: '',
    placement: 'HOME_TOP_BANNER' as AdPlacement,
    startDate: new Date().toISOString().split('T')[0],
    endDate: '2026-10-31',
    totalBudget: 150000,
    billingMethod: 'CPM' as 'CPM' | 'CPC' | 'FLAT_FEE',
    cpmRate: 120,
    cpcRate: 15,
    targetGeography: 'Pan-India',
    targetCategory: 'Electrical Supplies',
    creativeUrl: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=1200&auto=format&fit=crop&q=80',
    headline: 'Havells Heavy Duty Industrial Switches',
    ctaText: 'Know More',
    destinationUrl: '',
  });

  const getPlacementLocationLabel = (placement?: string): string => {
    if (!placement) return 'App Home Screen Top Banner';
    switch (placement) {
      case 'HOME_TOP_BANNER':
        return 'App Home Screen Top Carousel';
      case 'SEARCH_TOP_SPONSORED':
        return 'Top of Search Results Page';
      case 'CATEGORY_TOP_BANNER':
        return 'Category Storefront Top Banner';
      case 'PDP_CAROUSEL':
        return 'Product Detail Page (PDP) Slot';
      case 'CHECKOUT_BOTTOM':
        return 'Checkout Cart Summary Screen';
      case 'TRACKING_TOP_VIDEO_MAP':
      case 'ORDER_TRACKING_MAP_COLLAPSED':
        return 'Order Tracking: Map Header / Minimized Map Video Slot';
      case 'TRACKING_FLOATING_STICKY_BANNER':
      case 'ORDER_TRACKING_BELOW_MAP':
        return 'Order Tracking: Floating Card Ad (Below ETA Card)';
      case 'TRACKING_WHILE_YOU_WAIT_CAROUSEL':
        return 'Order Tracking: "While You Wait" Hero Carousel';
      case 'TRACKING_WHILE_YOU_WAIT_GRID':
        return 'Order Tracking: "While You Wait" 2x2 Feature Grid';
      case 'TRACKING_ABOVE_ORDER_DETAILS':
      case 'ORDER_TRACKING_FOOTER':
        return 'Order Tracking: Above Order Details Section';
      case 'ORDER_TRACKING_BANNER':
      case 'ORDER_TRACKING':
        return 'Order Tracking: General Screen';
      default:
        return placement.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase());
    }
  };

  const fetchCampaigns = async () => {
    try {
      setLoading(true);
      const res: any = await adminApi.get('/api/admin/ads/campaigns');
      if (res.success) {
        setCampaigns(res.campaigns || []);
      }
    } catch (err) {
      console.error('Failed to load ad campaigns:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCampaigns();
  }, []);

  const handleApprove = async (id: string) => {
    try {
      const res: any = await adminApi.post(`/api/admin/ads/campaigns/${id}/approve`, {});
      if (res.success) {
        setCampaigns((prev) =>
          prev.map((c) => (c.id === id ? res.campaign : c))
        );
      }
    } catch (err) {
      console.error('Failed to approve campaign:', err);
    }
  };

  const handleToggle = async (id: string) => {
    try {
      const res: any = await adminApi.post(`/api/admin/ads/campaigns/${id}/toggle`, {});
      if (res.success) {
        setCampaigns((prev) =>
          prev.map((c) => (c.id === id ? res.campaign : c))
        );
      }
    } catch (err) {
      console.error('Failed to toggle campaign:', err);
    }
  };

  const openCreateModal = () => {
    setEditingCampaign(null);
    setFormData({
      campaignName: '',
      advertiserBrand: '',
      brandContactEmail: '',
      placement: 'HOME_TOP_BANNER',
      startDate: new Date().toISOString().split('T')[0],
      endDate: '2026-10-31',
      totalBudget: 150000,
      billingMethod: 'CPM',
      cpmRate: 120,
      cpcRate: 15,
      targetGeography: 'Pan-India',
      targetCategory: 'Electrical Supplies',
      creativeUrl: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=1200&auto=format&fit=crop&q=80',
      headline: 'Havells Heavy Duty Industrial Switches',
      ctaText: 'Know More',
      destinationUrl: '',
    });
    setIsCreateModalOpen(true);
  };

  const openEditModal = (camp: SponsoredAdCampaign) => {
    setEditingCampaign(camp);
    setFormData({
      campaignName: camp.campaignName,
      advertiserBrand: camp.advertiserBrand,
      brandContactEmail: camp.brandContactEmail || 'ads@brand.com',
      placement: camp.placement,
      startDate: camp.startDate,
      endDate: camp.endDate,
      totalBudget: camp.totalBudget,
      billingMethod: camp.billingMethod as any,
      cpmRate: camp.cpmRate || 120,
      cpcRate: camp.cpcRate || 15,
      targetGeography: camp.targetGeography,
      targetCategory: camp.targetCategory || 'General',
      creativeUrl: camp.creativeUrl,
      headline: camp.headline,
      ctaText: camp.ctaText || 'Know More',
      destinationUrl: camp.destinationUrl || '',
    });
    setIsCreateModalOpen(true);
  };

  const handleSaveCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.campaignName || !formData.advertiserBrand) return;

    try {
      setSaving(true);
      if (editingCampaign) {
        // Edit flow
        const res: any = await adminApi.post(`/api/admin/ads/campaigns/${editingCampaign.id}/update`, formData);
        if (res.success) {
          setCampaigns((prev) =>
            prev.map((c) => (c.id === editingCampaign.id ? res.campaign : c))
          );
          setIsCreateModalOpen(false);
          setEditingCampaign(null);
        }
      } else {
        // Create flow
        const res: any = await adminApi.post('/api/admin/ads/campaigns/create', formData);
        if (res.success) {
          setCampaigns((prev) => [res.campaign, ...prev]);
          setIsCreateModalOpen(false);
        }
      }
    } catch (err) {
      console.error('Failed to save ad campaign:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCampaign = async (id: string) => {
    try {
      setSaving(true);
      const res: any = await adminApi.delete(`/api/admin/ads/campaigns/${id}`);
      if (res.success) {
        setCampaigns((prev) => prev.filter((c) => c.id !== id));
        setDeletingCampaignId(null);
      }
    } catch (err) {
      console.error('Failed to delete campaign:', err);
    } finally {
      setSaving(false);
    }
  };

  const filteredCampaigns = campaigns.filter((c) => {
    const matchesSearch =
      c.campaignName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.advertiserBrand.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.placement.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'ALL' || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const totalImpressions = campaigns.reduce((acc, c) => acc + (c.analytics?.impressions || 0), 0);
  const totalClicks = campaigns.reduce((acc, c) => acc + (c.analytics?.clicks || 0), 0);
  const totalAdRevenue = campaigns.reduce((acc, c) => acc + (c.spentBudget || 0), 0);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Sponsored Ads & Media
          </h1>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 rounded-md text-xs font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-colors cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New Ad Campaign</span>
          </button>

          <button
            onClick={fetchCampaigns}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200/90 transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)] cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#009DE0]' : 'text-slate-500'}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Top Media Performance KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-2xs">
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>Total Impressions</span>
            <Eye className="h-4 w-4 text-purple-600" />
          </div>
          <div className="text-xl font-bold text-slate-900 mt-1">{totalImpressions.toLocaleString('en-IN')}</div>
          <div className="text-[11px] text-emerald-600 font-medium mt-0.5">+18.4% this month</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-2xs">
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>Total Clicks</span>
            <MousePointer className="h-4 w-4 text-sky-600" />
          </div>
          <div className="text-xl font-bold text-slate-900 mt-1">{totalClicks.toLocaleString('en-IN')}</div>
          <div className="text-[11px] text-slate-500 font-medium mt-0.5">
            Avg CTR: {totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : '3.41'}%
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-2xs">
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>Ad Spend Realized</span>
            <IndianRupee className="h-4 w-4 text-[#009DE0]" />
          </div>
          <div className="text-xl font-bold text-slate-900 mt-1">₹{totalAdRevenue.toLocaleString('en-IN')}</div>
          <div className="text-[11px] text-purple-600 font-medium mt-0.5">100% Platform Margin</div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-2xs">
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>Avg Brand ROAS</span>
            <TrendingUp className="h-4 w-4 text-amber-600" />
          </div>
          <div className="text-xl font-bold text-slate-900 mt-1">6.8x</div>
          <div className="text-[11px] text-emerald-600 font-medium mt-0.5">High conversion rate</div>
        </div>
      </div>

      {/* Filters & Search */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search campaigns, brand advertisers or placement slots..."
            className="w-full pl-9 pr-4 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
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
            onClick={() => setStatusFilter('LIVE')}
            className={`px-3 py-1 rounded-lg font-medium transition-colors ${
              statusFilter === 'LIVE' ? 'bg-purple-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Live
          </button>
          <button
            onClick={() => setStatusFilter('PENDING_APPROVAL')}
            className={`px-3 py-1 rounded-lg font-medium transition-colors ${
              statusFilter === 'PENDING_APPROVAL' ? 'bg-amber-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Pending Review
          </button>
          <button
            onClick={() => setStatusFilter('PAUSED')}
            className={`px-3 py-1 rounded-lg font-medium transition-colors ${
              statusFilter === 'PAUSED' ? 'bg-slate-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Paused
          </button>
        </div>
      </div>

      {/* Campaigns Grid/List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <div className="col-span-full py-12 text-center text-slate-400">
            <RefreshCw className="h-6 w-6 animate-spin mx-auto text-purple-600 mb-2" />
            Loading ad campaigns...
          </div>
        ) : filteredCampaigns.length === 0 ? (
          <div className="col-span-full py-12 text-center text-slate-400 bg-white rounded-xl border border-slate-200">
            No sponsored ad campaigns found matching filters.
          </div>
        ) : (
          filteredCampaigns.map((camp) => (
            <div
              key={camp.id}
              className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between"
            >
              <div>
                <div className="h-28 bg-slate-100 relative overflow-hidden">
                  <img
                    src={camp.creativeUrl}
                    alt={camp.campaignName}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-slate-900/80 via-transparent to-transparent flex items-end p-3">
                    <div>
                      <span className="text-[10px] font-bold text-white bg-purple-600 px-2 py-0.5 rounded shadow-2xs">
                        Showing on: {getPlacementLocationLabel(camp.placement)}
                      </span>
                      <h3 className="text-white font-bold text-xs mt-1 truncate">{camp.headline}</h3>
                    </div>
                  </div>
                </div>

                <div className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h4 className="font-bold text-slate-900 text-sm truncate">{camp.campaignName}</h4>
                      <p className="text-xs text-purple-700 font-semibold">{camp.advertiserBrand}</p>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase shrink-0 ${
                        camp.status === 'LIVE'
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : camp.status === 'PENDING_APPROVAL'
                          ? 'bg-amber-50 text-amber-700 border border-amber-200'
                          : 'bg-slate-100 text-slate-700 border border-slate-200'
                      }`}
                    >
                      {camp.status}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 bg-slate-50 p-2.5 rounded-lg text-center text-xs">
                    <div>
                      <span className="text-[10px] text-slate-400 block">Impressions</span>
                      <span className="font-bold text-slate-900">
                        {((camp.analytics?.impressions || 0) / 1000).toFixed(1)}k
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-400 block">CTR</span>
                      <span className="font-bold text-slate-900">{camp.analytics?.ctrPercent || 3.8}%</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-400 block">ROAS</span>
                      <span className="font-bold text-emerald-600">{camp.analytics?.roasMultiplier || 6.4}x</span>
                    </div>
                  </div>

                  <div className="text-[11px] text-slate-500 space-y-1">
                    <div className="flex items-center justify-between">
                      <span>Budget Spent:</span>
                      <span className="font-medium text-slate-800">
                        ₹{(camp.spentBudget || 0).toLocaleString()} / ₹{(camp.totalBudget || 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Target Scope:</span>
                      <span className="font-medium text-slate-800">{camp.targetGeography}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setSelectedCampaignForDetail(camp)}
                    title="View Analytics & Detail"
                    className="px-2 py-1 text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    <span>Inspect</span>
                  </button>

                  <button
                    onClick={() => openEditModal(camp)}
                    title="Edit Campaign"
                    className="px-2 py-1 text-slate-600 hover:text-purple-700 hover:bg-purple-50 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                    <span>Edit</span>
                  </button>

                  <button
                    onClick={() => setDeletingCampaignId(camp.id)}
                    title="Delete Campaign"
                    className="px-2 py-1 text-rose-600 hover:text-rose-700 hover:bg-rose-50 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Delete</span>
                  </button>
                </div>

                <div className="flex items-center gap-1.5">
                  {camp.status === 'PENDING_APPROVAL' ? (
                    <button
                      onClick={() => handleApprove(camp.id)}
                      className="px-3 py-1.5 bg-[#009DE0] hover:bg-[#0087c2] text-white rounded-lg text-xs font-semibold shadow-2xs transition-colors flex items-center gap-1"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Approve & Launch
                    </button>
                  ) : (
                    <button
                      onClick={() => handleToggle(camp.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border ${
                        camp.status === 'LIVE'
                          ? 'border-amber-200 text-amber-700 hover:bg-amber-50'
                          : 'border-purple-200 text-purple-700 hover:bg-purple-50'
                      }`}
                    >
                      {camp.status === 'LIVE' ? 'Pause' : 'Resume'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Create / Edit Ad Campaign Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-xl max-h-[90vh] sm:max-h-[85vh] flex flex-col my-auto overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0 bg-white">
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Megaphone className="h-4 w-4 text-purple-600" />
                {editingCampaign ? 'Edit Ad Campaign' : 'Create Sponsored Ad Campaign'}
              </h2>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1 hover:bg-slate-100 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveCampaign} className="flex-1 flex flex-col min-h-0 overflow-hidden text-xs">
              <div className="p-6 space-y-4 overflow-y-auto flex-1">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Campaign Title *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Havells MCB Festival"
                      value={formData.campaignName}
                      onChange={(e) => setFormData({ ...formData, campaignName: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Brand Advertiser *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Havells India"
                      value={formData.advertiserBrand}
                      onChange={(e) => setFormData({ ...formData, advertiserBrand: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Placement Slot *</label>
                    <select
                      value={formData.placement}
                      onChange={(e) => setFormData({ ...formData, placement: e.target.value as AdPlacement })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500 font-medium text-slate-800 text-xs"
                    >
                      <optgroup label="Storefront Placements">
                        <option value="HOME_TOP_BANNER">Home Top Hero Banner</option>
                        <option value="CATEGORY_TOP_BANNER">Category Top Banner</option>
                        <option value="SEARCH_TOP_SPONSORED">Search Top Sponsored Boost</option>
                        <option value="PRODUCT_PAGE_SPONSORED">Product Detail Page Carousel</option>
                      </optgroup>
                      <optgroup label="Live Order Tracking Screen Placements">
                        <option value="TRACKING_TOP_VIDEO_MAP">1. Map Header / Minimized Map Video Slot (Top Video)</option>
                        <option value="TRACKING_FLOATING_STICKY_BANNER">2. Floating Banner (Below ETA Status Card)</option>
                        <option value="TRACKING_WHILE_YOU_WAIT_CAROUSEL">3. "While You Wait" Hero Carousel (1/6 Pagination)</option>
                        <option value="TRACKING_WHILE_YOU_WAIT_GRID">4. "While You Wait" 2x2 Feature Grid Ads</option>
                        <option value="TRACKING_ABOVE_ORDER_DETAILS">5. Above Order Items & Details Section</option>
                        <option value="ORDER_TRACKING_BANNER">General Order Tracking Page Banner</option>
                      </optgroup>
                    </select>
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Total Budget (₹) *</label>
                    <input
                      type="number"
                      required
                      value={formData.totalBudget}
                      onChange={(e) => setFormData({ ...formData, totalBudget: Number(e.target.value) })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Headline Text *</label>
                  <input
                    type="text"
                    required
                    value={formData.headline}
                    onChange={(e) => setFormData({ ...formData, headline: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>

                {/* CTA Action & Destination Link */}
                <div className="bg-purple-50/50 border border-purple-100 rounded-xl p-3.5 space-y-3">
                  <div className="flex items-center justify-between pb-1.5 border-b border-purple-200/50">
                    <div className="flex items-center gap-2">
                      <MousePointerClick className="h-4 w-4 text-purple-600" />
                      <span className="font-bold text-purple-900 text-xs">
                        Call to Action & Destination Link
                      </span>
                    </div>
                    <span className="text-[10px] text-purple-600 font-medium">Action & Deep Link</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block text-xs font-semibold text-slate-700">
                        CTA Button Text *
                      </label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. Know More, Apply Now"
                        value={formData.ctaText}
                        onChange={(e) => setFormData({ ...formData, ctaText: e.target.value })}
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500 text-xs font-semibold text-slate-900 shadow-2xs"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-xs font-semibold text-slate-700">
                        Destination URL / Deep Link
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. https://card.bank.com/apply or app://deals"
                        value={formData.destinationUrl}
                        onChange={(e) => setFormData({ ...formData, destinationUrl: e.target.value })}
                        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono text-[11px] text-slate-900 shadow-2xs"
                      />
                    </div>
                  </div>

                  <div className="pt-1">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <span className="text-[10px] font-semibold text-purple-700/80 uppercase tracking-wider">Quick Suggestions:</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {['Know More', 'Apply Now', 'Get Card', 'Book Free Scan', 'Get Offer', 'Claim Now', 'Explore'].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setFormData({ ...formData, ctaText: preset })}
                          className={`px-2.5 py-1 text-[11px] rounded-md font-medium transition-all ${
                            formData.ctaText === preset
                              ? 'bg-purple-600 text-white shadow-2xs font-semibold'
                              : 'bg-white hover:bg-purple-100 text-purple-900 border border-purple-200/80'
                          }`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Creative Image / Thumbnail URL</label>
                  <input
                    type="url"
                    value={formData.creativeUrl}
                    onChange={(e) => setFormData({ ...formData, creativeUrl: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono text-[11px]"
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
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg font-semibold shadow-xs transition-colors"
                >
                  {saving ? 'Saving...' : editingCampaign ? 'Update Campaign' : 'Submit Campaign'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Campaign Detail / Inspector Modal */}
      {selectedCampaignForDetail && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200 p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div>
                <span className="text-[10px] uppercase font-bold text-white bg-purple-600 px-2 py-0.5 rounded">
                  {selectedCampaignForDetail.placement.replace(/_/g, ' ')}
                </span>
                <h3 className="font-bold text-slate-900 text-base mt-2">{selectedCampaignForDetail.campaignName}</h3>
                <p className="text-purple-700 font-semibold">{selectedCampaignForDetail.advertiserBrand}</p>
              </div>
              <button
                onClick={() => setSelectedCampaignForDetail(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="h-32 bg-slate-100 rounded-xl overflow-hidden relative">
                <img
                  src={selectedCampaignForDetail.creativeUrl}
                  alt="ad creative"
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-900/80 via-transparent to-transparent flex items-end p-3">
                  <span className="text-white font-bold">{selectedCampaignForDetail.headline}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200">
                <div>
                  <span className="text-slate-500 block">Billing Method:</span>
                  <span className="font-bold text-slate-900">{selectedCampaignForDetail.billingMethod}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">Total Budget:</span>
                  <span className="font-bold text-slate-900">₹{selectedCampaignForDetail.totalBudget.toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">Spent Revenue:</span>
                  <span className="font-bold text-emerald-600">₹{(selectedCampaignForDetail.spentBudget || 0).toLocaleString()}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">Attributed ROAS:</span>
                  <span className="font-bold text-purple-700">{selectedCampaignForDetail.analytics?.roasMultiplier || 6.4}x</span>
                </div>
              </div>

              <div className="space-y-1.5 text-slate-600">
                <div className="flex items-center justify-between">
                  <span>Target Geography:</span>
                  <span className="font-medium text-slate-900">{selectedCampaignForDetail.targetGeography}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Category Scope:</span>
                  <span className="font-medium text-slate-900">{selectedCampaignForDetail.targetCategory || 'All'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Campaign Dates:</span>
                  <span className="font-mono text-slate-900">{selectedCampaignForDetail.startDate} to {selectedCampaignForDetail.endDate}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                onClick={() => {
                  const c = selectedCampaignForDetail;
                  setSelectedCampaignForDetail(null);
                  openEditModal(c);
                }}
                className="px-3.5 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg font-semibold flex items-center gap-1.5"
              >
                <Edit2 className="h-3.5 w-3.5" />
                Edit Campaign Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingCampaignId && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-sm overflow-hidden p-6 space-y-4 text-xs">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="p-2 bg-rose-50 rounded-xl">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-slate-900">Delete Ad Campaign?</h3>
                <p className="text-slate-500 text-[11px]">This will stop serving this ad placement across the app immediately.</p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => setDeletingCampaignId(null)}
                className="px-3 py-1.5 border border-slate-200 rounded-lg text-slate-700 font-medium hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteCampaign(deletingCampaignId)}
                disabled={saving}
                className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg font-semibold shadow-xs"
              >
                {saving ? 'Deleting...' : 'Delete Campaign'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

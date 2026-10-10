import React, { useState, useEffect } from 'react';
import {
  Layout,
  Plus,
  RefreshCw,
  Image as ImageIcon,
  CheckCircle2,
  X,
  Eye,
  Edit2,
  Trash2,
  PauseCircle,
  PlayCircle,
  Sparkles,
  AlertTriangle,
  FolderPlus,
  Tag,
  MousePointerClick,
  ExternalLink
} from 'lucide-react';
import { CmsHeroBanner, CmsCuratedCollection } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

export const CmsContentManager: React.FC = () => {
  const [banners, setBanners] = useState<CmsHeroBanner[]>([]);
  const [collections, setCollections] = useState<CmsCuratedCollection[]>([]);
  const [loading, setLoading] = useState(true);

  // Modals state
  const [isBannerModalOpen, setIsBannerModalOpen] = useState(false);
  const [editingBanner, setEditingBanner] = useState<CmsHeroBanner | null>(null);
  const [deletingBannerId, setDeletingBannerId] = useState<string | null>(null);

  const [isCollectionModalOpen, setIsCollectionModalOpen] = useState(false);
  const [editingCollection, setEditingCollection] = useState<CmsCuratedCollection | null>(null);
  const [deletingCollectionId, setDeletingCollectionId] = useState<string | null>(null);

  const [selectedBannerDetail, setSelectedBannerDetail] = useState<CmsHeroBanner | null>(null);
  const [saving, setSaving] = useState(false);

  // Banner Form
  const [bannerForm, setBannerForm] = useState({
    title: '',
    subtitle: '',
    imageUrl: 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=1200&auto=format&fit=crop&q=80',
    mediaType: 'IMAGE' as 'IMAGE' | 'VIDEO',
    videoUrl: '',
    ctaText: 'Know More',
    ctaUrl: '',
    actionType: 'DEEP_LINK' as 'DEEP_LINK' | 'EXTERNAL_URL' | 'PRODUCT_PAGE' | 'CATEGORY_HUB',
    targetScreen: 'HOME_EXPLORE',
    cityScope: 'all',
  });

  // Collection Form
  const [collectionForm, setCollectionForm] = useState({
    title: '',
    slug: '',
    subtitle: '',
    bannerBgColor: '#059669',
    productIdsStr: 'prod-01, prod-02, prod-03',
  });

  const fetchCmsContent = async () => {
    try {
      setLoading(true);
      const res: any = await adminApi.get('/api/admin/cms/banners');
      if (res.success) {
        setBanners(res.banners || []);
        setCollections(res.collections || []);
      }
    } catch (err) {
      console.error('Failed to load CMS content:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCmsContent();
  }, []);

  // --- BANNER HANDLERS ---
  const openCreateBannerModal = () => {
    setEditingBanner(null);
    setBannerForm({
      title: '',
      subtitle: '',
      imageUrl: 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=1200&auto=format&fit=crop&q=80',
      mediaType: 'IMAGE',
      videoUrl: '',
      ctaText: 'Know More',
      ctaUrl: '',
      actionType: 'DEEP_LINK',
      targetScreen: 'HOME_EXPLORE',
      cityScope: 'all',
    });
    setIsBannerModalOpen(true);
  };

  const openEditBannerModal = (banner: CmsHeroBanner) => {
    setEditingBanner(banner);
    setBannerForm({
      title: banner.title,
      subtitle: banner.subtitle || '',
      imageUrl: banner.imageUrl,
      mediaType: banner.mediaType || 'IMAGE',
      videoUrl: banner.videoUrl || '',
      ctaText: banner.ctaText || 'Know More',
      ctaUrl: banner.ctaUrl || '',
      actionType: banner.actionType || 'DEEP_LINK',
      targetScreen: banner.targetScreen || 'HOME_EXPLORE',
      cityScope: banner.cityScope || 'all',
    });
    setIsBannerModalOpen(true);
  };

  const handleSaveBanner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bannerForm.title || !bannerForm.imageUrl) return;

    try {
      setSaving(true);
      if (editingBanner) {
        const res: any = await adminApi.post(`/api/admin/cms/banners/${editingBanner.id}/update`, bannerForm);
        if (res.success) {
          setBanners((prev) => prev.map((b) => (b.id === editingBanner.id ? res.banner : b)));
          setIsBannerModalOpen(false);
          setEditingBanner(null);
        }
      } else {
        const res: any = await adminApi.post('/api/admin/cms/banners/create', bannerForm);
        if (res.success) {
          setBanners((prev) => [res.banner, ...prev]);
          setIsBannerModalOpen(false);
        }
      }
    } catch (err) {
      console.error('Failed to save banner:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleBanner = async (id: string) => {
    try {
      const res: any = await adminApi.post(`/api/admin/cms/banners/${id}/toggle`, {});
      if (res.success) {
        setBanners((prev) => prev.map((b) => (b.id === id ? res.banner : b)));
      }
    } catch (err) {
      console.error('Failed to toggle banner status:', err);
    }
  };

  const handleDeleteBanner = async (id: string) => {
    try {
      setSaving(true);
      const res: any = await adminApi.delete(`/api/admin/cms/banners/${id}`);
      if (res.success) {
        setBanners((prev) => prev.filter((b) => b.id !== id));
        setDeletingBannerId(null);
      }
    } catch (err) {
      console.error('Failed to delete banner:', err);
    } finally {
      setSaving(false);
    }
  };

  // --- COLLECTION HANDLERS ---
  const openCreateCollectionModal = () => {
    setEditingCollection(null);
    setCollectionForm({
      title: '',
      slug: '',
      subtitle: '',
      bannerBgColor: '#059669',
      productIdsStr: 'prod-01, prod-02, prod-03',
    });
    setIsCollectionModalOpen(true);
  };

  const openEditCollectionModal = (col: CmsCuratedCollection) => {
    setEditingCollection(col);
    setCollectionForm({
      title: col.title,
      slug: col.slug,
      subtitle: col.subtitle || '',
      bannerBgColor: col.bannerBgColor || '#059669',
      productIdsStr: (col.productIds || []).join(', '),
    });
    setIsCollectionModalOpen(true);
  };

  const handleSaveCollection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!collectionForm.title || !collectionForm.slug) return;

    const productIds = collectionForm.productIdsStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const payload = {
      title: collectionForm.title,
      slug: collectionForm.slug,
      subtitle: collectionForm.subtitle,
      bannerBgColor: collectionForm.bannerBgColor,
      productIds,
    };

    try {
      setSaving(true);
      if (editingCollection) {
        const res: any = await adminApi.post(`/api/admin/cms/collections/${editingCollection.id}/update`, payload);
        if (res.success) {
          setCollections((prev) => prev.map((c) => (c.id === editingCollection.id ? res.collection : c)));
          setIsCollectionModalOpen(false);
          setEditingCollection(null);
        }
      } else {
        const res: any = await adminApi.post('/api/admin/cms/collections/create', payload);
        if (res.success) {
          setCollections((prev) => [res.collection, ...prev]);
          setIsCollectionModalOpen(false);
        }
      }
    } catch (err) {
      console.error('Failed to save collection:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleCollection = async (id: string) => {
    try {
      const res: any = await adminApi.post(`/api/admin/cms/collections/${id}/toggle`, {});
      if (res.success) {
        setCollections((prev) => prev.map((c) => (c.id === id ? res.collection : c)));
      }
    } catch (err) {
      console.error('Failed to toggle collection status:', err);
    }
  };

  const handleDeleteCollection = async (id: string) => {
    try {
      setSaving(true);
      const res: any = await adminApi.delete(`/api/admin/cms/collections/${id}`);
      if (res.success) {
        setCollections((prev) => prev.filter((c) => c.id !== id));
        setDeletingCollectionId(null);
      }
    } catch (err) {
      console.error('Failed to delete collection:', err);
    } finally {
      setSaving(false);
    }
  };

  // Helper to get human-readable ad placement location
  const getPlacementLocationLabel = (targetScreen?: string): string => {
    if (!targetScreen) return 'App Homepage Main Carousel';
    switch (targetScreen) {
      case 'HOME_EXPLORE':
      case 'HOME_TOP_BANNER':
        return 'App Homepage Main Carousel';
      case 'CATEGORY_PLUMBING':
        return 'Plumbing & Dewatering Hub';
      case 'CATEGORY_ELECTRICAL':
        return 'Electrical & Switchgears Hub';
      case 'PROMOTIONS':
        return 'Deals & Clearance Storefront';
      case 'TRACKING_TOP_VIDEO_MAP':
      case 'ORDER_TRACKING_MAP_COLLAPSED':
        return 'Order Tracking: Map Header / Minimized Map Video Slot';
      case 'TRACKING_FLOATING_STICKY_BANNER':
      case 'ORDER_TRACKING_BELOW_MAP':
        return 'Order Tracking: Floating Banner (below ETA Status Card)';
      case 'TRACKING_WHILE_YOU_WAIT_CAROUSEL':
        return 'Order Tracking: "While You Wait" Hero Carousel (1/6 Pagination)';
      case 'TRACKING_WHILE_YOU_WAIT_GRID':
        return 'Order Tracking: "While You Wait" 2x2 Feature Ad Grid';
      case 'TRACKING_ABOVE_ORDER_DETAILS':
      case 'ORDER_TRACKING_FOOTER':
        return 'Order Tracking: Above Order Details & Items List';
      case 'ORDER_TRACKING':
      case 'ORDER_TRACKING_BANNER':
        return 'Order Tracking: General Screen';
      default:
        return targetScreen.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (l) => l.toUpperCase());
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Content Manager
          </h1>
        </div>

        <div className="flex items-center gap-2 flex-wrap self-start sm:self-auto">
          <button
            onClick={openCreateBannerModal}
            className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 rounded-md text-xs font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-colors cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New App Banner</span>
          </button>

          <button
            onClick={openCreateCollectionModal}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200/90 transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)] cursor-pointer"
          >
            <FolderPlus className="h-3.5 w-3.5 text-slate-400" />
            <span>New Collection</span>
          </button>

          <button
            onClick={fetchCmsContent}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200/90 transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)] cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#009DE0]' : 'text-slate-500'}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Hero Banners Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-[#009DE0]" />
            Active App Banners
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {banners.length === 0 ? (
            <div className="col-span-full py-12 text-center text-slate-400 bg-white rounded-xl border border-slate-200">
              No hero banners created yet. Click "Add Hero Banner" to publish one.
            </div>
          ) : (
            banners.map((banner) => (
              <div
                key={banner.id}
                className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between"
              >
                <div>
                  <div className="h-36 bg-slate-100 relative overflow-hidden">
                    <img
                      src={banner.imageUrl}
                      alt={banner.title}
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent flex items-end p-3.5">
                      <div>
                        <span className="text-[10px] uppercase font-bold text-[#38bdf8] bg-slate-950/80 px-2 py-0.5 rounded">
                          Hub Scope: {banner.cityScope}
                        </span>
                        <h3 className="text-white font-bold text-sm mt-1">{banner.title}</h3>
                      </div>
                    </div>
                  </div>

                  <div className="p-4 space-y-2.5 text-xs">
                    <p className="text-slate-600 line-clamp-2">{banner.subtitle}</p>

                    <div className="pt-2 border-t border-slate-100 space-y-1.5 text-[11px]">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1 text-slate-600 font-medium truncate">
                          <span className="text-slate-400">Showing on:</span>
                          <span className="font-semibold text-[#00608a] bg-sky-50 px-1.5 py-0.5 rounded border border-sky-200/70 truncate">
                            {getPlacementLocationLabel(banner.targetScreen)}
                          </span>
                        </div>
                        <span
                          className={`font-semibold flex items-center gap-1 shrink-0 ${
                            banner.isActive !== false ? 'text-[#009DE0]' : 'text-slate-400'
                          }`}
                        >
                          <CheckCircle2 className="h-3 w-3" />
                          {banner.isActive !== false ? 'Live' : 'Paused'}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-[10px] text-slate-500 pt-1">
                        <span className="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded font-bold border border-slate-200 flex items-center gap-1">
                          <span>🔘 CTA:</span>
                          <span className="text-[#009DE0]">{banner.ctaText || 'Know More'}</span>
                        </span>
                        {banner.ctaUrl && (
                          <span className="font-mono text-slate-500 truncate max-w-[130px]" title={banner.ctaUrl}>
                            🔗 {banner.ctaUrl}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setSelectedBannerDetail(banner)}
                      title="Inspect Banner Details"
                      className="px-2 py-1 text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      <span>Inspect</span>
                    </button>

                    <button
                      onClick={() => openEditBannerModal(banner)}
                      title="Edit Banner Settings"
                      className="px-2 py-1 text-slate-600 hover:text-[#009DE0] hover:bg-sky-50 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                      <span>Edit</span>
                    </button>

                    <button
                      onClick={() => setDeletingBannerId(banner.id)}
                      title="Delete Banner"
                      className="px-2 py-1 text-rose-600 hover:text-rose-700 hover:bg-rose-50 rounded-lg text-xs font-medium transition-colors flex items-center gap-1"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Delete</span>
                    </button>
                  </div>

                  <button
                    onClick={() => handleToggleBanner(banner.id)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors border ${
                      banner.isActive !== false
                        ? 'border-amber-200 text-amber-700 hover:bg-amber-50'
                        : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                    }`}
                  >
                    {banner.isActive !== false ? 'Pause' : 'Activate'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Curated Collections Section */}
      <div className="space-y-3 pt-4 border-t border-slate-200">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-purple-600" />
            Curated Trade Collections
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {collections.length === 0 ? (
            <div className="col-span-full py-8 text-center text-slate-400 bg-white rounded-xl border border-slate-200">
              No curated collections yet. Click "New Collection" to create one.
            </div>
          ) : (
            collections.map((col) => (
              <div
                key={col.id}
                className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs flex flex-col justify-between gap-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-slate-900 text-sm">{col.title}</h3>
                    <p className="text-xs text-slate-600 mt-1">{col.subtitle}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200">
                        {col.productIds?.length || 0} SKUs Curated
                      </span>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${
                          col.isActive !== false ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {col.isActive !== false ? 'Active' : 'Disabled'}
                      </span>
                    </div>
                  </div>

                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-xs shrink-0 shadow-2xs"
                    style={{ backgroundColor: col.bannerBgColor || '#059669' }}
                  >
                    CMS
                  </div>
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-slate-100 text-xs">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => openEditCollectionModal(col)}
                      className="px-2.5 py-1 text-slate-600 hover:text-purple-700 hover:bg-purple-50 rounded-lg transition-colors flex items-center gap-1 text-xs font-medium"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                      Edit Collection
                    </button>
                    <button
                      onClick={() => setDeletingCollectionId(col.id)}
                      className="px-2.5 py-1 text-rose-600 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-colors flex items-center gap-1 text-xs font-medium"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  </div>

                  <button
                    onClick={() => handleToggleCollection(col.id)}
                    className={`px-3 py-1 rounded-lg font-medium transition-colors text-[11px] border ${
                      col.isActive !== false
                        ? 'border-slate-200 text-slate-600 hover:bg-slate-100'
                        : 'border-purple-200 text-purple-700 hover:bg-purple-50'
                    }`}
                  >
                    {col.isActive !== false ? 'Disable Collection' : 'Enable Collection'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Create / Edit Hero Banner Modal */}
      {isBannerModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg max-h-[90vh] sm:max-h-[85vh] flex flex-col my-auto overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0 bg-white">
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Layout className="h-4 w-4 text-[#009DE0]" />
                {editingBanner ? 'Edit Banner' : 'Add App Banner / Video Ad'}
              </h2>
              <button
                onClick={() => setIsBannerModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1 hover:bg-slate-100 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveBanner} className="flex-1 flex flex-col min-h-0 overflow-hidden text-xs">
              <div className="p-6 space-y-4 overflow-y-auto flex-1">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Banner / Ad Title *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Monsoon Plumbing Essentials"
                    value={bannerForm.title}
                    onChange={(e) => setBannerForm({ ...bannerForm, title: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Subtitle / Callout</label>
                  <input
                    type="text"
                    placeholder="e.g. Up to 40% Off on Heavy Duty Astral & Supreme Pipes"
                    value={bannerForm.subtitle}
                    onChange={(e) => setBannerForm({ ...bannerForm, subtitle: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
                  />
                </div>

                {/* Media Format Selector */}
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Creative Media Format</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setBannerForm({ ...bannerForm, mediaType: 'IMAGE' })}
                      className={`py-2 px-3 rounded-lg border text-xs font-semibold transition-colors flex items-center justify-center gap-2 ${
                        bannerForm.mediaType === 'IMAGE'
                          ? 'border-[#009DE0] bg-sky-50 text-[#00608a]'
                          : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      <span>🖼️ Image Banner</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setBannerForm({ ...bannerForm, mediaType: 'VIDEO' })}
                      className={`py-2 px-3 rounded-lg border text-xs font-semibold transition-colors flex items-center justify-center gap-2 ${
                        bannerForm.mediaType === 'VIDEO'
                          ? 'border-purple-600 bg-purple-50 text-purple-800'
                          : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      <span>🎬 Video Ad (MP4 / Stream)</span>
                    </button>
                  </div>
                </div>

                {bannerForm.mediaType === 'VIDEO' && (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Video Stream URL (MP4 / WebM / HLS) *</label>
                    <input
                      type="url"
                      required={bannerForm.mediaType === 'VIDEO'}
                      placeholder="https://assets.mixkit.co/videos/preview/mixkit-hardware-store-construction-tools-42352-large.mp4"
                      value={bannerForm.videoUrl}
                      onChange={(e) => setBannerForm({ ...bannerForm, videoUrl: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono text-[11px]"
                    />
                    <p className="text-[10px] text-slate-500 mt-1">Video plays automatically when live map minimizes on customer tracking screen.</p>
                  </div>
                )}

                {/* CTA Action Configuration */}
                <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3.5 space-y-3">
                  <div className="flex items-center justify-between pb-1.5 border-b border-slate-200/60">
                    <div className="flex items-center gap-2">
                      <MousePointerClick className="h-4 w-4 text-[#009DE0]" />
                      <span className="font-bold text-slate-800 text-xs">
                        Call to Action & Destination Link
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-400 font-medium">Action & Deep Link</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block text-xs font-semibold text-slate-700">
                        CTA Button Text
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. Know More, Apply Now"
                        value={bannerForm.ctaText}
                        onChange={(e) => setBannerForm({ ...bannerForm, ctaText: e.target.value })}
                        className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0] text-xs font-semibold text-slate-900 shadow-2xs"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-xs font-semibold text-slate-700">
                        Destination URL / Deep Link
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. https://card.bank.com/apply or app://deals"
                        value={bannerForm.ctaUrl}
                        onChange={(e) => setBannerForm({ ...bannerForm, ctaUrl: e.target.value })}
                        className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0] font-mono text-[11px] text-slate-900 shadow-2xs"
                      />
                    </div>
                  </div>

                  <div className="pt-1">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Quick Suggestions:</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {['Know More', 'Apply Now', 'Get Card', 'Book Free Scan', 'Get Offer', 'Claim Now', 'Explore'].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setBannerForm({ ...bannerForm, ctaText: preset })}
                          className={`px-2.5 py-1 text-[11px] rounded-md font-medium transition-all ${
                            bannerForm.ctaText === preset
                              ? 'bg-[#009DE0] text-white shadow-2xs font-semibold'
                              : 'bg-white hover:bg-slate-100 text-slate-700 border border-slate-200'
                          }`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    {bannerForm.mediaType === 'VIDEO' ? 'Poster Thumbnail Image URL *' : 'Image URL *'}
                  </label>
                  <input
                    type="url"
                    required
                    value={bannerForm.imageUrl}
                    onChange={(e) => setBannerForm({ ...bannerForm, imageUrl: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0] font-mono text-[11px]"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">City Scope</label>
                    <select
                      value={bannerForm.cityScope}
                      onChange={(e) => setBannerForm({ ...bannerForm, cityScope: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
                    >
                      <option value="all">Pan-India (All Hubs)</option>
                      <option value="bengaluru">Bengaluru</option>
                      <option value="mumbai">Mumbai</option>
                      <option value="delhi_ncr">Delhi NCR</option>
                      <option value="hyderabad">Hyderabad</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Display Location / Placement</label>
                    <select
                      value={bannerForm.targetScreen}
                      onChange={(e) => setBannerForm({ ...bannerForm, targetScreen: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-[#009DE0] font-medium text-slate-800"
                    >
                      <optgroup label="Storefront Screens">
                        <option value="HOME_EXPLORE">App Homepage Main Carousel</option>
                        <option value="CATEGORY_PLUMBING">Category: Plumbing Hub</option>
                        <option value="CATEGORY_ELECTRICAL">Category: Electrical Hub</option>
                        <option value="PROMOTIONS">Deals & Clearance Storefront</option>
                      </optgroup>
                      <optgroup label="Live Order Tracking Screen Placements">
                        <option value="TRACKING_TOP_VIDEO_MAP">1. Map Header / Minimized Map Video Slot (Top Video)</option>
                        <option value="TRACKING_FLOATING_STICKY_BANNER">2. Floating Banner (Below ETA Status Card)</option>
                        <option value="TRACKING_WHILE_YOU_WAIT_CAROUSEL">3. "While You Wait" Main Carousel (Hero Banner)</option>
                        <option value="TRACKING_WHILE_YOU_WAIT_GRID">4. "While You Wait" 2x2 Feature Ad Grid</option>
                        <option value="TRACKING_ABOVE_ORDER_DETAILS">5. Above Order Items & Details Section</option>
                        <option value="ORDER_TRACKING">General Order Tracking Page Banner</option>
                      </optgroup>
                    </select>
                  </div>
                </div>
              </div>

              <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setIsBannerModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-lg font-medium text-slate-700 hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-[#009DE0] hover:bg-[#0087c2] text-white rounded-lg font-semibold shadow-xs transition-colors"
                >
                  {saving ? 'Saving...' : editingBanner ? 'Update Banner' : 'Publish Banner'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create / Edit Collection Modal */}
      {isCollectionModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg max-h-[90vh] sm:max-h-[85vh] flex flex-col my-auto overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0 bg-white">
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <FolderPlus className="h-4 w-4 text-purple-600" />
                {editingCollection ? 'Edit Collection' : 'New Curated Collection'}
              </h2>
              <button
                onClick={() => setIsCollectionModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1 hover:bg-slate-100 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveCollection} className="flex-1 flex flex-col min-h-0 overflow-hidden text-xs">
              <div className="p-6 space-y-4 overflow-y-auto flex-1">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Collection Title *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Heavy Duty Power Tools"
                      value={collectionForm.title}
                      onChange={(e) => setCollectionForm({ ...collectionForm, title: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">URL Slug *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. power-tools-fest"
                      value={collectionForm.slug}
                      onChange={(e) => setCollectionForm({ ...collectionForm, slug: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Subtitle</label>
                  <input
                    type="text"
                    placeholder="e.g. Professional grade drills and cutters for site contractors"
                    value={collectionForm.subtitle}
                    onChange={(e) => setCollectionForm({ ...collectionForm, subtitle: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Banner Color Hex</label>
                    <input
                      type="text"
                      value={collectionForm.bannerBgColor}
                      onChange={(e) => setCollectionForm({ ...collectionForm, bannerBgColor: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Product SKU IDs (comma separated)</label>
                    <input
                      type="text"
                      value={collectionForm.productIdsStr}
                      onChange={(e) => setCollectionForm({ ...collectionForm, productIdsStr: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
                    />
                  </div>
                </div>
              </div>

              <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setIsCollectionModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-lg font-medium text-slate-700 hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg font-semibold shadow-xs transition-colors"
                >
                  {saving ? 'Saving...' : editingCollection ? 'Update Collection' : 'Create Collection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Banner Detail Inspector */}
      {selectedBannerDetail && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200 p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div>
                <span className="text-[10px] uppercase font-bold text-[#00608a] bg-sky-50 px-2 py-0.5 rounded">
                  Target: {selectedBannerDetail.targetScreen}
                </span>
                <h3 className="font-bold text-slate-900 text-base mt-2">{selectedBannerDetail.title}</h3>
              </div>
              <button onClick={() => setSelectedBannerDetail(null)} className="text-slate-400 hover:text-slate-600 p-1">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="h-36 bg-slate-100 rounded-xl overflow-hidden relative">
                <img src={selectedBannerDetail.imageUrl} alt="banner" className="w-full h-full object-cover" />
              </div>
              <p className="text-slate-600 font-medium">{selectedBannerDetail.subtitle}</p>
              <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200">
                <div>
                  <span className="text-slate-500 block">City Scope:</span>
                  <span className="font-bold text-slate-900 uppercase">{selectedBannerDetail.cityScope}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">Active Status:</span>
                  <span className="font-bold text-emerald-600">
                    {selectedBannerDetail.isActive !== false ? 'Live' : 'Paused'}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                onClick={() => {
                  const b = selectedBannerDetail;
                  setSelectedBannerDetail(null);
                  openEditBannerModal(b);
                }}
                className="px-3.5 py-1.5 bg-[#009DE0] hover:bg-[#0087c2] text-white rounded-lg font-semibold flex items-center gap-1.5"
              >
                <Edit2 className="h-3.5 w-3.5" />
                Edit Banner
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Banner Confirmation */}
      {deletingBannerId && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-sm overflow-hidden p-6 space-y-4 text-xs">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="p-2 bg-rose-50 rounded-xl">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-slate-900">Delete Hero Banner?</h3>
                <p className="text-slate-500 text-[11px]">This banner will be removed from the homepage carousel.</p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => setDeletingBannerId(null)}
                className="px-3 py-1.5 border border-slate-200 rounded-lg text-slate-700 font-medium hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteBanner(deletingBannerId)}
                disabled={saving}
                className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg font-semibold shadow-xs"
              >
                {saving ? 'Deleting...' : 'Delete Banner'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Collection Confirmation */}
      {deletingCollectionId && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-sm overflow-hidden p-6 space-y-4 text-xs">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="p-2 bg-rose-50 rounded-xl">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-slate-900">Delete Curated Collection?</h3>
                <p className="text-slate-500 text-[11px]">This collection will no longer appear on customer storefronts.</p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => setDeletingCollectionId(null)}
                className="px-3 py-1.5 border border-slate-200 rounded-lg text-slate-700 font-medium hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteCollection(deletingCollectionId)}
                disabled={saving}
                className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg font-semibold shadow-xs"
              >
                {saving ? 'Deleting...' : 'Delete Collection'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

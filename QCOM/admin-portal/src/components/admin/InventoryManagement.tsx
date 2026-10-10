import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Package,
  Search,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Plus,
  Minus,
  Edit2,
  Filter,
  Tag,
  Store,
  MapPin,
  Building2,
  ExternalLink,
  ChevronRight,
  X,
  TrendingDown,
  TrendingUp,
  ShieldAlert,
  ArrowUpDown,
  Download,
  Info,
  Layers,
  Upload,
  Image as ImageIcon,
  Phone,
  AlertCircle
} from 'lucide-react';
import { AdminProduct, ProductSellerStock, AdminPermission } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

interface InventoryManagementProps {
  userPermissions: AdminPermission[];
  selectedCity?: string;
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
}

export const InventoryManagement: React.FC<InventoryManagementProps> = ({
  userPermissions,
  selectedCity = 'all',
  searchQuery: externalSearchQuery,
  onSearchQueryChange,
}) => {
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState(externalSearchQuery || '');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK'>('ALL');

  // Modal states
  const [selectedSkuForSellers, setSelectedSkuForSellers] = useState<AdminProduct | null>(null);
  const [sellerModalCityFilter, setSellerModalCityFilter] = useState<string>('ALL');
  const [sellerModalSearch, setSellerModalSearch] = useState<string>('');
  const [sellerModalStatusFilter, setSellerModalStatusFilter] = useState<string>('ALL');

  // Master Catalog Add/Edit Modal states
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isCatalogModalOpen, setIsCatalogModalOpen] = useState(false);
  const [editingMasterSku, setEditingMasterSku] = useState<AdminProduct | null>(null);
  const [skuForm, setSkuForm] = useState({
    sku: '',
    name: '',
    brand: '',
    category: 'Electrical & Switchgear',
    subcategory: '',
    hsnCode: '',
    gstRatePercent: 18,
    mrp: 100,
    unit: 'Piece',
    image: '',
  });

  // Adjust stock states
  const [adjustingSeller, setAdjustingSeller] = useState<{ product: AdminProduct; seller: ProductSellerStock } | null>(null);
  const [adjustingProductGeneral, setAdjustingProductGeneral] = useState<AdminProduct | null>(null);
  const [newStockQty, setNewStockQty] = useState<number>(0);
  const [newSellerPrice, setNewSellerPrice] = useState<number>(0);
  const [newMinStockAlert, setNewMinStockAlert] = useState<number>(10);
  const [restockReason, setRestockReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  const canEditStock = userPermissions.includes('inventory.edit_stock');

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

  const showToast = (msg: string) => {
    setSuccessToast(msg);
    setTimeout(() => setSuccessToast(null), 3500);
  };

  const fetchInventory = async () => {
    try {
      setLoading(true);
      const url = selectedCity && selectedCity !== 'all'
        ? `/api/admin/inventory?city=${selectedCity}`
        : '/api/admin/inventory';
      const res: any = await adminApi.get(url);
      if (res.success && Array.isArray(res.products)) {
        setProducts(res.products);
        // If modal is open, refresh the selected product in view as well
        if (selectedSkuForSellers) {
          const updatedSelected = res.products.find((p: AdminProduct) => p.id === selectedSkuForSellers.id || p.sku === selectedSkuForSellers.sku);
          if (updatedSelected) {
            setSelectedSkuForSellers(updatedSelected);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load inventory:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInventory();
  }, [selectedCity]);

  const openAddMasterSkuModal = () => {
    setEditingMasterSku(null);
    setSkuForm({
      sku: `SKU-${Date.now().toString().slice(-6)}`,
      name: '',
      brand: '',
      category: 'Electrical & Switchgear',
      subcategory: '',
      hsnCode: '',
      gstRatePercent: 18,
      mrp: 100,
      unit: 'Piece',
      image: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=300&auto=format&fit=crop&q=80',
    });
    setIsCatalogModalOpen(true);
  };

  const openEditMasterSkuModal = (product: AdminProduct) => {
    setEditingMasterSku(product);
    setSkuForm({
      sku: product.sku || product.id,
      name: product.name,
      brand: product.brand,
      category: product.category,
      subcategory: product.subcategory || '',
      hsnCode: product.hsnCode || '',
      gstRatePercent: product.gstRatePercent || 18,
      mrp: product.mrp || product.price || 100,
      unit: product.unit || 'Piece',
      image: product.image || 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=300&auto=format&fit=crop&q=80',
    });
    setIsCatalogModalOpen(true);
  };

  const handleImageFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        alert('Image size exceeds 5MB limit.');
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        setSkuForm((prev) => ({ ...prev, image: reader.result as string }));
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSaveMasterSku = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!skuForm.sku.trim() || !skuForm.name.trim() || !skuForm.brand.trim() || !skuForm.hsnCode.trim()) {
      alert('Please fill in all required fields (SKU, Name, Brand, HSN Code).');
      return;
    }

    try {
      setIsSubmitting(true);
      if (editingMasterSku) {
        // Edit existing SKU in Master Catalog
        const res: any = await adminApi.put(`/api/admin/catalog/products/${editingMasterSku.id}`, skuForm);
        if (res.success) {
          showToast(`SKU ${skuForm.sku} updated in Master Catalog.`);
          setIsCatalogModalOpen(false);
          await fetchInventory();
        } else {
          alert(res.message || 'Failed to update Master SKU.');
        }
      } else {
        // Add new SKU to Master Catalog
        const res: any = await adminApi.post('/api/admin/catalog/products', skuForm);
        if (res.success) {
          showToast(`New Master Product "${skuForm.name}" added to Catalog.`);
          setIsCatalogModalOpen(false);
          await fetchInventory();
        } else {
          alert(res.message || 'Failed to add Master SKU.');
        }
      }
    } catch (err: any) {
      console.error('Error saving Master SKU:', err);
      alert(err.message || 'Server error while saving Master SKU.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle single seller stock & price adjustment
  const handleAdjustSellerStock = async () => {
    if (!adjustingSeller) return;
    try {
      setIsSubmitting(true);
      const res: any = await adminApi.post(`/api/admin/inventory/${adjustingSeller.product.id}/adjust-seller-stock`, {
        sellerId: adjustingSeller.seller.sellerId,
        newStockCount: newStockQty,
        newPrice: newSellerPrice,
        newMinStockAlert: newMinStockAlert,
        reason: restockReason || 'Physical store inventory cycle count & price sync',
      });
      if (res.success) {
        showToast(`Updated ${adjustingSeller.seller.sellerName}: ${newStockQty} units @ ₹${newSellerPrice}`);
        setAdjustingSeller(null);
        setRestockReason('');
        await fetchInventory();
      }
    } catch (err: any) {
      alert(err.message || 'Failed to adjust seller stock');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle general product stock adjustment
  const handleAdjustGeneralStock = async () => {
    if (!adjustingProductGeneral) return;
    try {
      setIsSubmitting(true);
      const res: any = await adminApi.post(`/api/admin/inventory/${adjustingProductGeneral.id}/adjust-stock`, {
        newStockCount: newStockQty,
        reason: restockReason || 'Catalog stock audit',
      });
      if (res.success) {
        showToast(`Overall stock updated to ${newStockQty} units for ${adjustingProductGeneral.sku}`);
        setAdjustingProductGeneral(null);
        setRestockReason('');
        await fetchInventory();
      }
    } catch (err: any) {
      alert(err.message || 'Failed to adjust stock');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Helper to evaluate stock health for a product and its sellers
  const getProductStockHealth = (p: AdminProduct) => {
    const sellers = p.sellers || [];
    const totalStock = p.stockCount;
    const minBuffer = p.minStockAlert || 20;

    const outOfStockSellers = sellers.filter((s) => s.stockCount === 0);
    const lowStockSellers = sellers.filter((s) => s.stockCount > 0 && s.stockCount <= (s.minStockAlert || 10));

    const isGlobalOutOfStock = totalStock === 0;
    const isGlobalLowStock = totalStock > 0 && totalStock <= minBuffer;
    const hasSellerLowStock = lowStockSellers.length > 0;
    const hasSellerOutOfStock = outOfStockSellers.length > 0;

    const isAnyOutOfStock = isGlobalOutOfStock || hasSellerOutOfStock;
    const isAnyLowStock = isGlobalLowStock || hasSellerLowStock;
    const isHealthy = !isAnyOutOfStock && !isAnyLowStock;

    return {
      totalStock,
      minBuffer,
      outOfStockSellers,
      lowStockSellers,
      isGlobalOutOfStock,
      isGlobalLowStock,
      hasSellerLowStock,
      hasSellerOutOfStock,
      isAnyOutOfStock,
      isAnyLowStock,
      isHealthy,
    };
  };

  // Compute status counts for filter chips with multi-seller intelligence
  const statusCounts = useMemo(() => {
    let all = products.length;
    let healthy = 0;
    let low = 0;
    let outOfStock = 0;

    products.forEach((p) => {
      const health = getProductStockHealth(p);
      if (health.isAnyOutOfStock) {
        outOfStock++;
      }
      if (health.isAnyLowStock) {
        low++;
      }
      if (health.isHealthy) {
        healthy++;
      }
    });

    return { all, healthy, low, outOfStock };
  }, [products]);

  // Filtered Products for Master SKU Table
  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      // Status filter with multi-seller intelligence
      let matchesStatus = true;
      const health = getProductStockHealth(p);

      if (statusFilter === 'OUT_OF_STOCK') {
        matchesStatus = health.isAnyOutOfStock;
      } else if (statusFilter === 'LOW_STOCK') {
        matchesStatus = health.isAnyLowStock;
      } else if (statusFilter === 'IN_STOCK') {
        matchesStatus = health.isHealthy;
      }

      // Search Query filter (matches SKU, Name, Brand, HSN, or Seller Name)
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        (p.sku && p.sku.toLowerCase().includes(q)) ||
        p.name.toLowerCase().includes(q) ||
        p.brand.toLowerCase().includes(q) ||
        p.hsnCode.includes(q) ||
        (p.sellers && p.sellers.some((s) => s.sellerName.toLowerCase().includes(q) || s.areaName.toLowerCase().includes(q) || s.cityName.toLowerCase().includes(q)));

      return matchesStatus && matchesSearch;
    });
  }, [products, statusFilter, searchQuery]);

  // Filtered sellers in the SKU Breakdown Modal
  const modalFilteredSellers = useMemo(() => {
    if (!selectedSkuForSellers || !selectedSkuForSellers.sellers) return [];
    return selectedSkuForSellers.sellers.filter((s) => {
      const matchesCity =
        sellerModalCityFilter === 'ALL' ||
        s.cityId.toLowerCase() === sellerModalCityFilter.toLowerCase() ||
        s.cityName.toLowerCase() === sellerModalCityFilter.toLowerCase();

      const q = sellerModalSearch.toLowerCase().trim();
      const matchesSearch =
        !q ||
        s.sellerName.toLowerCase().includes(q) ||
        s.areaName.toLowerCase().includes(q) ||
        s.cityName.toLowerCase().includes(q) ||
        (s.sellerContact && s.sellerContact.includes(q));

      let matchesStatus = true;
      if (sellerModalStatusFilter === 'ONLINE') {
        matchesStatus = s.isStoreOnline;
      } else if (sellerModalStatusFilter === 'OFFLINE') {
        matchesStatus = !s.isStoreOnline;
      } else if (sellerModalStatusFilter === 'OUT_OF_STOCK') {
        matchesStatus = s.stockCount === 0;
      } else if (sellerModalStatusFilter === 'LOW_STOCK') {
        matchesStatus = s.stockCount <= (s.minStockAlert || 10);
      } else if (sellerModalStatusFilter === 'IN_STOCK') {
        matchesStatus = s.stockCount > (s.minStockAlert || 10);
      }

      return matchesCity && matchesSearch && matchesStatus;
    });
  }, [selectedSkuForSellers, sellerModalCityFilter, sellerModalSearch, sellerModalStatusFilter]);

  // Aggregate stats across filtered sellers in modal
  const modalStats = useMemo(() => {
    const sellers = modalFilteredSellers;
    const totalUnits = sellers.reduce((sum, s) => sum + s.stockCount, 0);
    const onlineCount = sellers.filter((s) => s.isStoreOnline).length;
    const outOfStockCount = sellers.filter((s) => s.stockCount === 0).length;
    const lowStockCount = sellers.filter((s) => s.stockCount > 0 && s.stockCount <= (s.minStockAlert || 10)).length;
    const validPrices = sellers.map((s) => s.price).filter((pr) => typeof pr === 'number' && pr > 0);
    const avgPrice = validPrices.length > 0
      ? Math.round(validPrices.reduce((sum, pr) => sum + pr, 0) / validPrices.length)
      : (selectedSkuForSellers?.price || 0);
    const minPrice = validPrices.length > 0 ? Math.min(...validPrices) : (selectedSkuForSellers?.price || 0);
    const maxPrice = validPrices.length > 0 ? Math.max(...validPrices) : (selectedSkuForSellers?.price || 0);

    return {
      totalUnits,
      sellerCount: sellers.length,
      onlineCount,
      outOfStockCount,
      lowStockCount,
      avgPrice,
      minPrice,
      maxPrice,
    };
  }, [modalFilteredSellers, selectedSkuForSellers]);

  // Check if selected SKU in modal has any low stock alerts
  const modalAlertInfo = useMemo(() => {
    if (!selectedSkuForSellers || !selectedSkuForSellers.sellers) return null;
    const health = getProductStockHealth(selectedSkuForSellers);
    return health;
  }, [selectedSkuForSellers]);

  // Export inventory to CSV
  const handleExportCsv = () => {
    const headers = ['SKU Code', 'Product Name', 'Brand', 'Category', 'HSN Code', 'GST %', 'Price (INR)', 'MRP (INR)', 'Overall Stock', 'Unit', 'Min Buffer', 'Status', 'Sellers Count'];
    const rows = filteredProducts.map((p) => {
      const health = getProductStockHealth(p);
      const statusLabel = health.isGlobalOutOfStock
        ? 'Out of Stock (All Stores)'
        : health.hasSellerOutOfStock
        ? `Out of Stock (${health.outOfStockSellers.length} Hubs Empty)`
        : health.isGlobalLowStock
        ? 'Low Stock (Overall)'
        : health.hasSellerLowStock
        ? `Low Stock (${health.lowStockSellers.length} Hubs Low)`
        : 'In Stock';

      return [
        `"${p.sku || p.id}"`,
        `"${p.name.replace(/"/g, '""')}"`,
        `"${p.brand}"`,
        `"${p.category}"`,
        `"${p.hsnCode}"`,
        `"${p.gstRatePercent}%"`,
        p.price,
        p.mrp,
        p.stockCount,
        p.unit,
        p.minStockAlert,
        `"${statusLabel}"`,
        p.sellers ? p.sellers.length : (p.sellerCount || 1),
      ].join(',');
    });

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `QCOM_Inventory_SKUs_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Success Toast */}
      {successToast && (
        <div className="fixed bottom-5 right-5 z-50 bg-slate-900 text-white px-4 py-2.5 rounded-lg shadow-lg text-xs font-medium flex items-center gap-2 border border-slate-700 animate-in fade-in slide-in-from-bottom-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
          <span>{successToast}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <span>Master Catalog</span>
          </h1>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            onClick={openAddMasterSkuModal}
            className="flex items-center gap-1.5 bg-[#009DE0] hover:bg-[#0087c2] text-white px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors shadow-xs"
            title="Add a new master SKU / Model No. to the catalog"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add SKU to Catalog</span>
          </button>

          <button
            onClick={handleExportCsv}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200/80 transition-colors shadow-xs"
            title="Export CSV of current filtered catalog"
          >
            <Download className="h-3.5 w-3.5 text-slate-500" />
            <span>Export CSV</span>
          </button>

          <button
            onClick={fetchInventory}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200/80 transition-colors shadow-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#009DE0]' : 'text-slate-500'}`} />
            <span>Sync Catalog</span>
          </button>
        </div>
      </div>

      {/* Search & Stock Filter Bar */}
      <div className="bg-white border border-slate-200/80 rounded-xl p-3.5 shadow-xs">
        <div className="flex flex-col md:flex-row items-center gap-2.5">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search by SKU Code (SKU-ELE-3201), Product Name, Brand (Havells, Astral, Hilti), HSN Code or Seller..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full bg-slate-50/75 border border-slate-200/80 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
            />
            {searchQuery && (
              <button
                onClick={() => handleSearchChange('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Stock Availability Filter Pills with Live Counts */}
          <div className="flex items-center gap-1 self-start md:self-auto shrink-0 text-xs">
            <span className="text-[11px] text-slate-400 font-medium mr-1">Status:</span>
            {[
              { key: 'ALL', label: `All Stock (${statusCounts.all})`, color: 'bg-slate-900 text-white' },
              { key: 'IN_STOCK', label: `In Stock (${statusCounts.healthy})`, color: 'bg-emerald-700 text-white' },
              { key: 'LOW_STOCK', label: `Low Stock (${statusCounts.low})`, color: 'bg-amber-600 text-white' },
              { key: 'OUT_OF_STOCK', label: `Out of Stock (${statusCounts.outOfStock})`, color: 'bg-rose-700 text-white' },
            ].map((st) => (
              <button
                key={st.key}
                onClick={() => setStatusFilter(st.key as any)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  statusFilter === st.key
                    ? `${st.color} shadow-xs font-semibold`
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200/80'
                }`}
              >
                {st.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Inventory Table: SKU -> Product Details -> HSN&GST -> SKU Price/MRP -> Overall Stock -> Status -> Action */}
      <div className="bg-white border border-slate-200/80 rounded-xl overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[900px]">
            <thead className="bg-slate-50 text-slate-600 text-xs font-semibold border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left w-36">SKU</th>
                <th className="px-4 py-3 text-left min-w-[240px]">Product Details</th>
                <th className="px-4 py-3 text-center w-28">HSN & GST</th>
                <th className="px-4 py-3 text-right w-36">Price Range</th>
                <th className="px-4 py-3 text-center w-28">Overall Stock</th>
                <th className="px-4 py-3 text-center w-28">Status</th>
                <th className="px-4 py-3 text-right pr-4 w-32">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading && products.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                    <RefreshCw className="h-6 w-6 animate-spin text-[#009DE0] mx-auto mb-2" />
                    <span>Loading SKU inventory & seller allocations...</span>
                  </td>
                </tr>
              ) : filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                    <Package className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                    <p className="font-medium text-slate-600">No SKUs match the current filters</p>
                    <p className="text-xs text-slate-400 mt-0.5">Try selecting "All Stock" or clearing search/category filters</p>
                  </td>
                </tr>
              ) : (
                filteredProducts.map((p) => {
                  const health = getProductStockHealth(p);
                  const sellersCount = p.sellers ? p.sellers.length : (p.sellerCount || 1);
                  const hasPriceRange = p.minPrice && p.maxPrice && p.minPrice !== p.maxPrice;

                  return (
                    <tr
                      key={p.id || p.sku}
                      className="hover:bg-slate-50/70 transition-colors group cursor-pointer"
                      onClick={() => {
                        setSelectedSkuForSellers(p);
                        setSellerModalCityFilter('ALL');
                        setSellerModalSearch('');
                        setSellerModalStatusFilter('ALL');
                      }}
                    >
                      {/* 1. SKU Badge */}
                      <td className="px-4 py-3.5 align-middle whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5 bg-slate-100 group-hover:bg-emerald-50 text-slate-800 group-hover:text-emerald-800 border border-slate-200/90 group-hover:border-emerald-200 px-2 py-0.5 rounded-md font-mono text-xs font-semibold transition-colors">
                          <Package className="h-3 w-3 text-slate-400 group-hover:text-emerald-600 shrink-0" />
                          <span>{p.sku || p.id}</span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-1">
                          <Store className="h-3 w-3 text-slate-400 shrink-0" />
                          <span>{sellersCount} {sellersCount === 1 ? 'Seller' : 'Sellers'} stocking</span>
                        </div>
                      </td>

                      {/* 2. Product Details */}
                      <td className="px-4 py-3.5 align-middle">
                        <div className="flex items-center gap-2.5">
                          {p.image ? (
                            <img
                              src={p.image}
                              alt={p.name}
                              className="w-9 h-9 object-contain rounded-md border border-slate-200 bg-white shrink-0 p-0.5 shadow-2xs"
                            />
                          ) : (
                            <div className="w-9 h-9 rounded-md border border-slate-200 bg-slate-100 flex items-center justify-center shrink-0">
                              <Package className="h-4 w-4 text-slate-400" />
                            </div>
                          )}
                          <div>
                            <div className="font-semibold text-slate-900 text-xs leading-snug group-hover:text-emerald-950 transition-colors">
                              {p.name}
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-slate-500">
                              <span className="font-normal text-slate-600">Brand: <strong className="font-semibold text-slate-800">{p.brand}</strong></span>
                              <span className="text-slate-300">•</span>
                              <span className="truncate text-slate-400">{p.category}{p.subcategory ? ` › ${p.subcategory}` : ''}</span>
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* 3. HSN & GST */}
                      <td className="px-4 py-3.5 align-middle text-center whitespace-nowrap">
                        <div className="font-mono text-xs font-medium text-slate-800">
                          HSN {p.hsnCode}
                        </div>
                        <div className="inline-block mt-0.5 text-blue-700 bg-blue-50 border border-blue-200/70 px-1.5 py-0.2 rounded text-[11px] font-semibold">
                          {p.gstRatePercent}% GST
                        </div>
                      </td>

                      {/* 4. SKU Price Range / MRP */}
                      <td className="px-4 py-3.5 align-middle text-right whitespace-nowrap">
                        <div className="font-semibold text-slate-900 text-xs tabular-nums">
                          {hasPriceRange
                            ? `₹${p.minPrice!.toLocaleString('en-IN')} – ₹${p.maxPrice!.toLocaleString('en-IN')}`
                            : `₹${(p.minPrice || p.price).toLocaleString('en-IN')}`}
                        </div>
                        <div className="text-[11px] text-slate-400 font-normal tabular-nums line-through mt-0.5">
                          MRP ₹{p.mrp.toLocaleString('en-IN')}
                        </div>
                      </td>

                      {/* 5. Overall Current Stock */}
                      <td className="px-4 py-3.5 align-middle text-center whitespace-nowrap">
                        <div className={`text-xs font-bold tabular-nums ${
                          health.isGlobalOutOfStock
                            ? 'text-rose-600'
                            : health.isGlobalLowStock
                            ? 'text-amber-600'
                            : 'text-slate-900'
                        }`}>
                          {health.totalStock.toLocaleString('en-IN')} <span className="font-normal text-slate-500">{p.unit}s</span>
                        </div>
                      </td>

                      {/* 6. Status */}
                      <td className="px-4 py-3.5 align-middle text-center whitespace-nowrap">
                        {health.isGlobalOutOfStock ? (
                          <span className="inline-flex items-center gap-1.5 bg-rose-50 text-rose-700 border border-rose-200 px-2.5 py-0.5 rounded-full text-xs font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
                            Out of Stock
                          </span>
                        ) : health.hasSellerOutOfStock ? (
                          <span className="inline-flex items-center gap-1.5 bg-rose-50 text-rose-700 border border-rose-300 px-2.5 py-0.5 rounded-full text-xs font-medium" title={`${health.outOfStockSellers.length} store(s) out of stock`}>
                            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
                            Out of Stock ({health.outOfStockSellers.length})
                          </span>
                        ) : health.isGlobalLowStock ? (
                          <span className="inline-flex items-center gap-1.5 bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-0.5 rounded-full text-xs font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                            Low Stock
                          </span>
                        ) : health.hasSellerLowStock ? (
                          <span className="inline-flex items-center gap-1.5 bg-amber-50 text-amber-800 border border-amber-300 px-2.5 py-0.5 rounded-full text-xs font-medium" title={`${health.lowStockSellers.length} store(s) below safety buffer`}>
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                            Low Stock ({health.lowStockSellers.length})
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 py-0.5 rounded-full text-xs font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            In Stock
                          </span>
                        )}
                      </td>

                      {/* 7. Action */}
                      <td className="px-4 py-3.5 align-middle text-right whitespace-nowrap pr-4" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => {
                              setSelectedSkuForSellers(p);
                              setSellerModalCityFilter('ALL');
                              setSellerModalSearch('');
                              setSellerModalStatusFilter('ALL');
                            }}
                            className="bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200/80 px-2.5 py-1 rounded-md text-xs font-semibold inline-flex items-center gap-1 transition-colors shadow-2xs"
                            title="View all sellers stocking this SKU"
                          >
                            <Store className="h-3 w-3 text-emerald-700" />
                            <span>Sellers ({sellersCount})</span>
                          </button>

                          <button
                            onClick={() => openEditMasterSkuModal(p)}
                            className="text-slate-500 hover:text-slate-900 hover:bg-slate-100 p-1.5 rounded-md text-xs transition-colors"
                            title="Edit / Override Master SKU details"
                          >
                            <Edit2 className="h-3.5 w-3.5 text-slate-400" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* SKU SELLER DISTRIBUTION & STOCK BREAKDOWN MODAL */}
      {selectedSkuForSellers && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
          <div className="bg-white border border-slate-200/90 rounded-2xl w-full max-w-6xl shadow-2xl flex flex-col max-h-[88vh] overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="p-5 sm:p-6 bg-slate-50/90 border-b border-slate-200/80 flex items-start justify-between gap-4">
              <div className="flex items-start gap-4">
                {selectedSkuForSellers.image ? (
                  <img
                    src={selectedSkuForSellers.image}
                    alt={selectedSkuForSellers.name}
                    className="w-16 h-16 object-contain rounded-xl border border-slate-200 bg-white p-1 shrink-0 shadow-xs"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-xl border border-slate-200 bg-slate-100 flex items-center justify-center shrink-0">
                    <Package className="h-8 w-8 text-slate-400" />
                  </div>
                )}
                
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-200/90 px-2.5 py-1 rounded-md shadow-2xs">
                      {selectedSkuForSellers.sku || selectedSkuForSellers.id}
                    </span>
                    <span className="text-xs font-semibold text-slate-700 bg-slate-200/80 px-2.5 py-1 rounded-md">
                      {selectedSkuForSellers.category}
                    </span>
                    <span className="text-xs font-medium text-slate-500">
                      HSN {selectedSkuForSellers.hsnCode} • {selectedSkuForSellers.gstRatePercent}% GST
                    </span>
                  </div>
                  
                  <h2 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
                    {selectedSkuForSellers.name}
                  </h2>
                  
                  <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                    <span>Brand: <strong className="text-slate-900">{selectedSkuForSellers.brand}</strong></span>
                    <span className="text-slate-300">•</span>
                    <div className="inline-flex items-center gap-1.5 bg-slate-100 border border-slate-200/90 text-slate-800 px-2.5 py-0.5 rounded-md font-semibold text-xs">
                      <span>Price Range:</span>
                      <strong className="text-slate-950 font-bold">
                        {modalStats.minPrice !== modalStats.maxPrice
                          ? `₹${modalStats.minPrice.toLocaleString('en-IN')} – ₹${modalStats.maxPrice.toLocaleString('en-IN')}`
                          : `₹${modalStats.minPrice.toLocaleString('en-IN')}`}
                      </strong>
                    </div>
                    <span className="text-slate-300">•</span>
                    <span className="text-slate-500 font-medium">
                      Catalog MRP: <strong className="text-slate-700 font-bold">₹{selectedSkuForSellers.mrp.toLocaleString('en-IN')}</strong>
                    </span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => setSelectedSkuForSellers(null)}
                className="text-slate-400 hover:text-slate-700 bg-white hover:bg-slate-100 p-2 rounded-xl border border-slate-200 transition-colors shadow-2xs shrink-0"
                title="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Store Alert Banners (if applicable) */}
            {modalAlertInfo && modalAlertInfo.hasSellerOutOfStock && (
              <div className="bg-rose-50 border-b border-rose-200 px-5 py-3 flex items-center gap-2.5 text-xs text-rose-900">
                <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" />
                <span>
                  <strong>Out of Stock Alert:</strong>{' '}
                  {modalAlertInfo.outOfStockSellers.length} store(s) have 0 units available:{' '}
                  {modalAlertInfo.outOfStockSellers
                    .map((s) => `${s.sellerName} (${s.cityName})`)
                    .join('; ')}
                </span>
              </div>
            )}
            {modalAlertInfo && modalAlertInfo.hasSellerLowStock && !modalAlertInfo.hasSellerOutOfStock && (
              <div className="bg-amber-50/90 border-b border-amber-200 px-5 py-3 flex items-center gap-2.5 text-xs text-amber-900">
                <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                <span>
                  <strong>Store Buffer Warning:</strong>{' '}
                  {modalAlertInfo.lowStockSellers.length} store(s) below minimum safety buffer ({modalAlertInfo.minBuffer} units):{' '}
                  {modalAlertInfo.lowStockSellers
                    .map((s) => `${s.sellerName} (${s.cityName}: ${s.stockCount}u)`)
                    .join('; ')}
                </span>
              </div>
            )}

            {/* Modal Quick Filter & Search Bar */}
            <div className="p-4 sm:p-5 bg-white border-b border-slate-100 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* City Filter */}
                <div>
                  <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Filter By City</label>
                  <select
                    value={sellerModalCityFilter}
                    onChange={(e) => setSellerModalCityFilter(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200/90 rounded-lg px-3 py-2 text-xs text-slate-900 font-medium focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                  >
                    <option value="ALL">All Operating Cities</option>
                    <option value="bengaluru">Bengaluru (KA)</option>
                    <option value="mumbai">Mumbai MMR (MH)</option>
                    <option value="delhi">Delhi NCR (DL/HR)</option>
                    <option value="hyderabad">Hyderabad (TS)</option>
                    <option value="chennai">Chennai (TN)</option>
                    <option value="pune">Pune (MH)</option>
                    <option value="kolkata">Kolkata (WB)</option>
                  </select>
                </div>

                {/* Area / Store Search */}
                <div>
                  <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Search Seller / Area</label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search store name, locality, hub..."
                      value={sellerModalSearch}
                      onChange={(e) => setSellerModalSearch(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200/90 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                    />
                  </div>
                </div>

                {/* Store Status Filter */}
                <div>
                  <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Store / Stock State</label>
                  <select
                    value={sellerModalStatusFilter}
                    onChange={(e) => setSellerModalStatusFilter(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200/90 rounded-lg px-3 py-2 text-xs text-slate-900 font-medium focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                  >
                    <option value="ALL">All Stores & Stock Levels</option>
                    <option value="ONLINE">Online Stores Only</option>
                    <option value="OFFLINE">Offline Stores Only</option>
                    <option value="IN_STOCK">In Stock (Healthy)</option>
                    <option value="LOW_STOCK">Low Stock (≤ Safety Buffer)</option>
                    <option value="OUT_OF_STOCK">Out of Stock (0 Units)</option>
                  </select>
                </div>
              </div>

              {/* Aggregated Scope Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3">
                  <span className="text-[11px] text-slate-500 font-medium block">Total Units in Scope</span>
                  <span className="text-base font-bold text-slate-900 mt-0.5 block">
                    {modalStats.totalUnits.toLocaleString('en-IN')} <span className="text-xs font-semibold text-slate-500">{selectedSkuForSellers.unit}s</span>
                  </span>
                </div>
                <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3">
                  <span className="text-[11px] text-slate-500 font-medium block">Stocking Sellers</span>
                  <span className="text-base font-bold text-slate-900 mt-0.5 block">
                    {modalStats.sellerCount} Stores <span className="text-xs font-semibold text-emerald-700">({modalStats.onlineCount} Online)</span>
                  </span>
                </div>
                <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3">
                  <span className="text-[11px] text-slate-500 font-medium block">Price Range Across Stores</span>
                  <span className="text-base font-bold text-slate-900 mt-0.5 block">
                    {modalStats.minPrice !== modalStats.maxPrice
                      ? `₹${modalStats.minPrice.toLocaleString('en-IN')} – ₹${modalStats.maxPrice.toLocaleString('en-IN')}`
                      : `₹${modalStats.minPrice.toLocaleString('en-IN')}`}
                  </span>
                </div>
                <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3">
                  <span className="text-[11px] text-slate-500 font-medium block">Stock Availability</span>
                  <span className={`text-base font-bold mt-0.5 block ${
                    modalStats.outOfStockCount > 0
                      ? 'text-rose-600'
                      : modalStats.lowStockCount > 0
                      ? 'text-amber-600'
                      : 'text-emerald-700'
                  }`}>
                    {modalStats.outOfStockCount > 0
                      ? `${modalStats.outOfStockCount} Stores Empty`
                      : modalStats.lowStockCount > 0
                      ? `${modalStats.lowStockCount} Stores Low`
                      : 'All Stores Healthy'}
                  </span>
                </div>
              </div>
            </div>

            {/* Sellers Breakdown Table */}
            <div className="overflow-y-auto flex-1 p-5 sm:p-6 min-h-[280px]">
              <table className="w-full text-left text-xs min-w-[880px]">
                <thead className="bg-slate-50/90 text-slate-600 text-xs font-semibold border-b border-slate-200 uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-3">Seller & Trade Partner</th>
                    <th className="px-4 py-3">City & Hub Area</th>
                    <th className="px-4 py-3 text-center">Store Status</th>
                    <th className="px-4 py-3 text-right">Store Listed Price</th>
                    <th className="px-4 py-3 text-center">Available Stock</th>
                    <th className="px-4 py-3 text-center">Safety Buffer</th>
                    <th className="px-4 py-3 text-right pr-4">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {modalFilteredSellers.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                        <Store className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                        <span className="text-sm font-medium">No sellers found matching the selected city or search filter</span>
                      </td>
                    </tr>
                  ) : (
                    modalFilteredSellers.map((s) => {
                      const isSellerOutOfStock = s.stockCount === 0;
                      const isSellerLowStock = s.stockCount > 0 && s.stockCount <= (s.minStockAlert || 10);

                      return (
                        <tr
                          key={s.sellerId}
                          className={`transition-colors ${
                            isSellerOutOfStock
                              ? 'bg-rose-50/40 hover:bg-rose-50/70'
                              : isSellerLowStock
                              ? 'bg-amber-50/30 hover:bg-amber-50/60'
                              : 'hover:bg-slate-50/80'
                          }`}
                        >
                          {/* Seller Name & Contact */}
                          <td className="px-4 py-3.5">
                            <div className="font-bold text-slate-900 text-xs flex items-center gap-1.5">
                              <span>{s.sellerName}</span>
                              {isSellerOutOfStock ? (
                                <span className="bg-rose-100 text-rose-800 text-[10px] font-bold px-2 py-0.5 rounded border border-rose-200">
                                  EMPTY (0u)
                                </span>
                              ) : isSellerLowStock ? (
                                <span className="bg-amber-100 text-amber-800 text-[10px] font-bold px-2 py-0.5 rounded border border-amber-200">
                                  LOW
                                </span>
                              ) : null}
                            </div>
                            <div className="text-[11px] text-slate-500 flex items-center gap-1.5 mt-1">
                              <Phone className="h-3 w-3 text-slate-400" />
                              <span>{s.sellerContact || '+91 98450 12345'}</span>
                              {s.lastRestockedAt && (
                                <>
                                  <span className="text-slate-300">•</span>
                                  <span>Synced: {s.lastRestockedAt}</span>
                                </>
                              )}
                            </div>
                          </td>

                          {/* City & Area */}
                          <td className="px-4 py-3.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-slate-900 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded text-[10px]">
                                {s.cityName}
                              </span>
                            </div>
                            <div className="text-xs text-slate-600 font-medium flex items-center gap-1 mt-1">
                              <MapPin className="h-3 w-3 text-slate-400 shrink-0" />
                              <span className="truncate max-w-[220px]">{s.areaName}</span>
                            </div>
                          </td>

                          {/* Store Online Status */}
                          <td className="px-4 py-3.5 text-center whitespace-nowrap">
                            {s.isStoreOnline ? (
                              <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 py-1 rounded-md text-[11px] font-semibold">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                Online
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 bg-slate-100 text-slate-600 border border-slate-200 px-2.5 py-1 rounded-md text-[11px] font-semibold">
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                                Offline
                              </span>
                            )}
                          </td>

                          {/* Store Listed Price / MRP */}
                          <td className="px-4 py-3.5 text-right whitespace-nowrap">
                            <div className="font-bold text-slate-900 text-sm">
                              ₹{s.price.toLocaleString('en-IN')}
                            </div>
                            <div className="text-[10px] text-slate-400 line-through mt-0.5">
                              MRP ₹{s.mrp.toLocaleString('en-IN')}
                            </div>
                          </td>

                          {/* Available Stock Units */}
                          <td className="px-4 py-3.5 text-center whitespace-nowrap">
                            <div className={`text-sm font-bold ${
                              isSellerOutOfStock ? 'text-rose-600' : isSellerLowStock ? 'text-amber-700' : 'text-slate-900'
                            }`}>
                              {s.stockCount} <span className="text-xs font-semibold text-slate-600">{selectedSkuForSellers.unit}s</span>
                            </div>
                            <div className="text-[10px] font-medium mt-0.5">
                              {isSellerOutOfStock ? (
                                <span className="text-rose-600 font-semibold bg-rose-50 px-1.5 py-0.2 rounded border border-rose-200">Out of Stock</span>
                              ) : isSellerLowStock ? (
                                <span className="text-amber-700 font-semibold bg-amber-50 px-1.5 py-0.2 rounded border border-amber-200">Low Stock</span>
                              ) : (
                                <span className="text-emerald-700 font-semibold">In Stock</span>
                              )}
                            </div>
                          </td>

                          {/* Safety Buffer */}
                          <td className="px-4 py-3.5 text-center whitespace-nowrap">
                            <span className="text-xs font-semibold text-slate-700 bg-slate-100 px-2.5 py-1 rounded-md">
                              {s.minStockAlert || 10} units
                            </span>
                          </td>

                          {/* Action */}
                          <td className="px-4 py-3.5 text-right whitespace-nowrap pr-4">
                            <button
                              onClick={() => {
                                setAdjustingSeller({
                                  product: selectedSkuForSellers,
                                  seller: s,
                                });
                                setNewStockQty(s.stockCount);
                                setNewSellerPrice(s.price);
                                setNewMinStockAlert(s.minStockAlert || 10);
                                setRestockReason('');
                              }}
                              disabled={!canEditStock}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-colors border shadow-2xs ${
                                isSellerOutOfStock
                                  ? 'bg-rose-600 hover:bg-rose-700 text-white border-rose-600'
                                  : isSellerLowStock
                                  ? 'bg-amber-600 hover:bg-amber-700 text-white border-amber-600'
                                  : 'text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border-emerald-200/90'
                              }`}
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                              <span>{isSellerOutOfStock ? 'Restock' : 'Adjust Stock & Price'}</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Modal Footer */}
            <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
              <span>Showing <strong>{modalFilteredSellers.length}</strong> sellers for SKU <strong>{selectedSkuForSellers.sku}</strong></span>
              <button
                onClick={() => setSelectedSkuForSellers(null)}
                className="px-5 py-2 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-lg text-xs transition-colors shadow-2xs"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADJUST SPECIFIC SELLER STOCK & PRICE MODAL */}
      {adjustingSeller && (
        <div className="fixed inset-0 z-60 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200/90 rounded-2xl w-full max-w-lg p-6 shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start justify-between">
              <div>
                <span className="font-mono text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                  {adjustingSeller.product.sku}
                </span>
                <h3 className="font-bold text-slate-900 text-base mt-1.5">Adjust Store Stock & Listed Price</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Update inventory and catalog price for <strong>{adjustingSeller.seller.sellerName}</strong> ({adjustingSeller.seller.cityName}).
                </p>
              </div>
              <button
                onClick={() => setAdjustingSeller(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              {/* Unit Count */}
              <div>
                <label className="text-slate-700 font-semibold block mb-1.5">
                  Verified Unit Stock ({adjustingSeller.product.unit}s)
                </label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setNewStockQty(Math.max(0, newStockQty - 10))}
                    className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold border border-slate-200 transition-colors"
                  >
                    -10
                  </button>
                  <button
                    onClick={() => setNewStockQty(Math.max(0, newStockQty - 1))}
                    className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold border border-slate-200 transition-colors"
                  >
                    -1
                  </button>
                  <input
                    type="number"
                    min={0}
                    value={newStockQty}
                    onChange={(e) => setNewStockQty(Math.max(0, Number(e.target.value)))}
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-lg py-2 px-3 text-center text-slate-900 font-mono text-base font-bold focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                  />
                  <button
                    onClick={() => setNewStockQty(newStockQty + 1)}
                    className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold border border-slate-200 transition-colors"
                  >
                    +1
                  </button>
                  <button
                    onClick={() => setNewStockQty(newStockQty + 10)}
                    className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold border border-slate-200 transition-colors"
                  >
                    +10
                  </button>
                </div>
                <div className="text-[11px] text-slate-500 mt-1 flex justify-between">
                  <span>Current: {adjustingSeller.seller.stockCount} units</span>
                  <span>Safety Buffer: {newMinStockAlert} units</span>
                </div>
              </div>

              {/* Seller Listed Price */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-slate-700 font-semibold block mb-1.5">
                    Seller Listed Price (₹)
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={newSellerPrice}
                    onChange={(e) => setNewSellerPrice(Math.max(1, Number(e.target.value)))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg py-2 px-3 text-slate-900 font-mono text-sm font-bold focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                  />
                  <div className="text-[10px] text-slate-400 mt-1">
                    Catalog MRP: ₹{adjustingSeller.product.mrp}
                  </div>
                </div>

                <div>
                  <label className="text-slate-700 font-semibold block mb-1.5">
                    Min Stock Safety Buffer (Units)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={newMinStockAlert}
                    onChange={(e) => setNewMinStockAlert(Math.max(0, Number(e.target.value)))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg py-2 px-3 text-slate-900 font-mono text-sm font-bold focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                  />
                  <div className="text-[10px] text-slate-400 mt-1">
                    Triggers low stock alert when ≤ threshold
                  </div>
                </div>
              </div>

              {/* Reason */}
              <div>
                <label className="text-slate-700 font-semibold block mb-1.5">Adjustment Reason / Audit Trail</label>
                <input
                  type="text"
                  placeholder="e.g. Physical cycle count audit, Inbound supplier delivery, Price update..."
                  value={restockReason}
                  onChange={(e) => setRestockReason(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 placeholder-slate-400 text-xs focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
              <button
                onClick={() => setAdjustingSeller(null)}
                className="px-4 py-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 font-medium rounded-lg text-xs transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAdjustSellerStock}
                disabled={isSubmitting}
                className="px-5 py-2 bg-[#009DE0] hover:bg-[#0087c2] text-white font-semibold rounded-lg text-xs shadow-xs transition-colors disabled:opacity-50"
              >
                {isSubmitting ? 'Updating...' : 'Save & Update Store Stock'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADJUST GENERAL CATALOG STOCK MODAL */}
      {adjustingProductGeneral && (
        <div className="fixed inset-0 z-60 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200/90 rounded-2xl w-full max-w-md p-5 shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start justify-between">
              <div>
                <span className="font-mono text-[10px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                  {adjustingProductGeneral.sku}
                </span>
                <h3 className="font-bold text-slate-900 text-sm mt-1">Adjust Overall Catalog Stock</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Update central aggregate unit count for <strong>{adjustingProductGeneral.name}</strong>.
                </p>
              </div>
              <button
                onClick={() => setAdjustingProductGeneral(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3.5 text-xs">
              <div>
                <label className="text-slate-700 font-semibold block mb-1">
                  Total Overall Units ({adjustingProductGeneral.unit}s)
                </label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setNewStockQty(Math.max(0, newStockQty - 10))}
                    className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold border border-slate-200"
                  >
                    -10
                  </button>
                  <input
                    type="number"
                    min={0}
                    value={newStockQty}
                    onChange={(e) => setNewStockQty(Math.max(0, Number(e.target.value)))}
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-lg py-1.5 px-3 text-center text-slate-900 font-mono text-base font-bold focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                  />
                  <button
                    onClick={() => setNewStockQty(newStockQty + 10)}
                    className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold border border-slate-200"
                  >
                    +10
                  </button>
                </div>
              </div>

              <div>
                <label className="text-slate-700 font-semibold block mb-1">Audit Reason</label>
                <input
                  type="text"
                  placeholder="e.g. Catalog inventory reconciliation..."
                  value={restockReason}
                  onChange={(e) => setRestockReason(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-slate-900 placeholder-slate-400 text-xs focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                onClick={() => setAdjustingProductGeneral(null)}
                className="px-3 py-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 font-medium rounded-lg text-xs transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAdjustGeneralStock}
                disabled={isSubmitting}
                className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white font-semibold rounded-lg text-xs shadow-xs transition-colors disabled:opacity-50"
              >
                {isSubmitting ? 'Updating...' : 'Update Overall Stock'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADD / EDIT MASTER CATALOG SKU MODAL */}
      {isCatalogModalOpen && (
        <div className="fixed inset-0 z-60 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[88vh] my-auto overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="p-4 sm:p-5 border-b border-slate-100 shrink-0 flex items-start justify-between gap-3 bg-white">
              <div>
                <h3 className="font-bold text-slate-900 text-base flex items-center gap-2">
                  <Package className="h-5 w-5 text-[#009DE0]" />
                  <span>{editingMasterSku ? 'Edit / Override Master SKU' : 'Add New SKU to Master Catalog'}</span>
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsCatalogModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSaveMasterSku} className="flex flex-col flex-1 overflow-hidden min-h-0">
              {/* Scrollable Content */}
              <div className="p-4 sm:p-5 space-y-3.5 text-xs overflow-y-auto flex-1">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-slate-700 font-semibold block mb-1">SKU / Model No. *</label>
                    <input
                      type="text"
                      disabled={!!editingMasterSku}
                      placeholder="e.g. SKU-ELE-3201"
                      value={skuForm.sku}
                      onChange={(e) => setSkuForm({ ...skuForm, sku: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 placeholder-slate-400 text-xs font-mono font-medium focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:opacity-60"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-slate-700 font-semibold block mb-1">Brand Name *</label>
                    <input
                      type="text"
                      placeholder="e.g. Schneider Electric, Polycab, Hilti"
                      value={skuForm.brand}
                      onChange={(e) => setSkuForm({ ...skuForm, brand: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 placeholder-slate-400 text-xs focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                      required
                    />
                  </div>
                </div>

                <div>
                  <label className="text-slate-700 font-semibold block mb-1">Product Title / Name *</label>
                  <input
                    type="text"
                    placeholder="e.g. Schneider Electric 32A Triple Pole MCB (C-Curve 10kA)"
                    value={skuForm.name}
                    onChange={(e) => setSkuForm({ ...skuForm, name: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 placeholder-slate-400 text-xs focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-slate-700 font-semibold block mb-1">Main Category *</label>
                    <select
                      value={skuForm.category}
                      onChange={(e) => setSkuForm({ ...skuForm, category: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-xs focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                    >
                      <option value="Electrical & Switchgear">Electrical & Switchgear</option>
                      <option value="Cables & Wiring">Cables & Wiring</option>
                      <option value="Fasteners & Rigging">Fasteners & Rigging</option>
                      <option value="Power Tools">Power Tools</option>
                      <option value="Plumbing & Pipes">Plumbing & Pipes</option>
                      <option value="Safety & PPE">Safety & PPE</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-slate-700 font-semibold block mb-1">Subcategory</label>
                    <input
                      type="text"
                      placeholder="e.g. Circuit Breakers, FR Wires"
                      value={skuForm.subcategory}
                      onChange={(e) => setSkuForm({ ...skuForm, subcategory: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 placeholder-slate-400 text-xs focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-slate-700 font-semibold block mb-1">HSN Code *</label>
                    <input
                      type="text"
                      placeholder="e.g. 85362030"
                      value={skuForm.hsnCode}
                      onChange={(e) => setSkuForm({ ...skuForm, hsnCode: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 placeholder-slate-400 text-xs font-mono focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-slate-700 font-semibold block mb-1">GST Rate (%) *</label>
                    <select
                      value={skuForm.gstRatePercent}
                      onChange={(e) => setSkuForm({ ...skuForm, gstRatePercent: Number(e.target.value) })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-xs focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                    >
                      <option value={0}>0% GST</option>
                      <option value={5}>5% GST</option>
                      <option value={12}>12% GST</option>
                      <option value={18}>18% GST</option>
                      <option value={28}>28% GST</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-slate-700 font-semibold block mb-1">MRP (₹)</label>
                    <input
                      type="number"
                      min={0}
                      placeholder="750"
                      value={skuForm.mrp}
                      onChange={(e) => setSkuForm({ ...skuForm, mrp: Number(e.target.value) })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 text-xs font-mono focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-slate-700 font-semibold block mb-1">Unit Type</label>
                  <input
                    type="text"
                    placeholder="Piece, Box, Roll, Meter, Set, Unit"
                    value={skuForm.unit}
                    onChange={(e) => setSkuForm({ ...skuForm, unit: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 placeholder-slate-400 text-xs focus:bg-white focus:outline-none focus:ring-1 focus:ring-slate-900"
                  />
                </div>

                {/* Official Manufacturer Image Upload Section */}
                <div className="bg-slate-50/80 border border-slate-200 rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-slate-800 font-bold flex items-center gap-1.5">
                      <ImageIcon className="h-4 w-4 text-[#009DE0]" />
                      <span>Official Manufacturer Image</span>
                    </label>
                    <span className="text-[11px] text-slate-500 font-normal">Shown to sellers during store listing</span>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="relative w-16 h-16 rounded-lg border border-slate-200 bg-white overflow-hidden shrink-0 flex items-center justify-center group shadow-2xs">
                      {skuForm.image ? (
                        <img src={skuForm.image} alt="Official product visual" className="w-full h-full object-contain p-1" />
                      ) : (
                        <Package className="h-6 w-6 text-slate-300" />
                      )}
                    </div>

                    <div className="flex-1 space-y-1.5">
                      <input
                        type="url"
                        placeholder="Paste official picture URL (https://...)"
                        value={skuForm.image}
                        onChange={(e) => setSkuForm({ ...skuForm, image: e.target.value })}
                        className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-900 placeholder-slate-400 text-xs focus:outline-none focus:ring-1 focus:ring-slate-900"
                      />
                      
                      <div className="flex items-center gap-2">
                        <input
                          type="file"
                          ref={fileInputRef}
                          accept="image/*"
                          onChange={handleImageFileUpload}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="flex items-center gap-1.5 bg-white hover:bg-slate-100 text-slate-700 px-2.5 py-1 rounded-md text-[11px] font-semibold border border-slate-200 transition-colors shadow-2xs"
                        >
                          <Upload className="h-3 w-3 text-[#009DE0]" />
                          <span>Upload Local Photo</span>
                        </button>
                        <span className="text-[10px] text-slate-400">JPG, PNG, WebP up to 5MB</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Fixed Footer */}
              <div className="p-4 border-t border-slate-100 bg-slate-50/80 shrink-0 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsCatalogModalOpen(false)}
                  className="px-4 py-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 font-medium rounded-lg text-xs transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 bg-[#009DE0] hover:bg-[#0087c2] text-white font-semibold rounded-lg text-xs shadow-xs transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  {isSubmitting ? 'Saving...' : (editingMasterSku ? 'Update Master SKU' : 'Save to Master Catalog')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

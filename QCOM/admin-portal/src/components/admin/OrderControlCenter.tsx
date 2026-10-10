import React, { useState, useEffect } from 'react';
import {
  Search,
  Eye,
  AlertTriangle,
  Bike,
  RefreshCw,
  Download,
  PauseCircle,
  Flame,
  Filter,
  CheckCircle,
  Clock,
  MapPin,
  ChevronRight
} from 'lucide-react';
import { AdminOrder, AdminRider, AdminPermission } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';
import { exportToCsv } from '../../utils/exportToSheet';
import { OrderDetailModal } from './OrderDetailModal';

interface OrderControlCenterProps {
  userPermissions: AdminPermission[];
  selectedCity?: string;
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
}

export const OrderControlCenter: React.FC<OrderControlCenterProps> = ({
  userPermissions,
  selectedCity = 'all',
  searchQuery: externalSearchQuery,
  onSearchQueryChange,
}) => {
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [riders, setRiders] = useState<AdminRider[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState(externalSearchQuery || '');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [priorityFilter, setPriorityFilter] = useState('ALL');
  const [holdOnlyFilter, setHoldOnlyFilter] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<AdminOrder | null>(null);

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

  const canEditStatus = userPermissions.includes('orders.edit_status');
  const canCancel = userPermissions.includes('orders.cancel');
  const canAssignRider = userPermissions.includes('orders.assign_rider');

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (searchQuery) params.append('q', searchQuery);
      if (statusFilter !== 'ALL') params.append('status', statusFilter);
      if (selectedCity && selectedCity !== 'all') params.append('city', selectedCity);

      const [ordersRes, ridersRes]: [any, any] = await Promise.all([
        adminApi.get(`/api/admin/orders?${params.toString()}`),
        adminApi.get(`/api/admin/riders${selectedCity && selectedCity !== 'all' ? `?city=${selectedCity}` : ''}`),
      ]);

      if (ordersRes.success) {
        let fetchedOrders: AdminOrder[] = ordersRes.orders;
        if (priorityFilter !== 'ALL') {
          fetchedOrders = fetchedOrders.filter((o) => o.priority === priorityFilter);
        }
        if (holdOnlyFilter) {
          fetchedOrders = fetchedOrders.filter((o) => o.isHold);
        }
        setOrders(fetchedOrders);
      }
      if (ridersRes.success) setRiders(ridersRes.riders);
    } catch (err) {
      console.error('Error fetching orders:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, [searchQuery, statusFilter, priorityFilter, holdOnlyFilter, selectedCity]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchOrders();
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'placed':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-sky-50 text-sky-700 border border-sky-200/60">
            <span className="w-1.5 h-1.5 rounded-full bg-sky-500" />
            Placed
          </span>
        );
      case 'picking':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200/60">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            Preparing
          </span>
        );
      case 'packed':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-purple-50 text-purple-700 border border-purple-200/60">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
            Ready
          </span>
        );
      case 'out_for_delivery':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200/60">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
            On Way
          </span>
        );
      case 'arriving':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-teal-50 text-teal-700 border border-teal-200/60">
            <span className="w-1.5 h-1.5 rounded-full bg-teal-500" />
            Arriving
          </span>
        );
      case 'delivered':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Delivered
          </span>
        );
      case 'cancelled':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-50 text-rose-700 border border-rose-200/60">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
            Cancelled
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-600 border border-slate-200">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
            {status}
          </span>
        );
    }
  };

  const handleExportOrders = () => {
    exportToCsv<AdminOrder>('qcom_orders_dataset', [
      { header: 'Order ID', accessor: (o) => o.id },
      { header: 'Order Number', accessor: (o) => o.orderNumber },
      { header: 'Customer Name', accessor: (o) => o.customer?.name || 'Guest' },
      { header: 'Customer Phone', accessor: (o) => o.customer?.phone || '' },
      { header: 'Seller Store Name', accessor: (o) => o.seller?.name || '' },
      { header: 'City', accessor: (o) => o.deliveryLocation?.city || 'Bengaluru' },
      { header: 'Total Amount (INR)', accessor: (o) => o.pricing?.total || 0 },
      { header: 'Payment Status', accessor: (o) => o.payment?.status },
      { header: 'Payment Method', accessor: (o) => o.payment?.method },
      { header: 'Order Status', accessor: (o) => o.status },
      { header: 'Urgency Priority', accessor: (o) => o.priority || 'NORMAL' },
      { header: 'On Hold', accessor: (o) => (o.isHold ? 'YES' : 'NO') },
      { header: 'Assigned Rider', accessor: (o) => o.rider?.name || 'Unassigned' },
      { header: 'Rider Phone', accessor: (o) => o.rider?.phone || 'N/A' },
      { header: 'Placed At', accessor: (o) => o.placedAt },
    ], orders);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Orders Control Center
          </h1>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            onClick={handleExportOrders}
            className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white px-3 py-1.5 rounded-md text-xs font-medium transition-colors shadow-[0_1px_2px_rgba(0,0,0,0.06)] cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export CSV</span>
          </button>
          <button
            onClick={fetchOrders}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200/90 transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)] cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#009DE0]' : 'text-slate-500'}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="bg-white border border-slate-200/90 rounded-lg p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.02)] space-y-3">
        <form onSubmit={handleSearchSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search by order ID, customer, phone, store, area..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full bg-slate-50/80 border border-slate-200/80 rounded-md pl-9 pr-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#009DE0]/15 focus:border-[#009DE0] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
            />
          </div>
          <button
            type="submit"
            className="bg-slate-900 hover:bg-slate-800 text-white font-medium px-3.5 py-1.5 rounded-md text-xs transition-colors cursor-pointer shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
          >
            Search
          </button>
        </form>

        {/* Filter Chips */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-100/80">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {['ALL', 'placed', 'picking', 'packed', 'out_for_delivery', 'delivered', 'cancelled'].map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`px-2.5 py-1 rounded-md text-xs transition-all cursor-pointer ${
                  statusFilter === st
                    ? 'bg-slate-900 text-white font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                    : 'bg-slate-100/80 text-slate-600 hover:bg-slate-200/70'
                }`}
              >
                {st === 'ALL' ? 'All Orders' : st === 'picking' ? 'Preparing' : st.replace(/_/g, ' ')}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-xs">
            {/* Urgency Filter */}
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="bg-slate-50 border border-slate-200/90 rounded-md px-2.5 py-1 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-[#009DE0] font-medium cursor-pointer"
            >
              <option value="ALL">All Urgency</option>
              <option value="NORMAL">Normal</option>
              <option value="HIGH">High Priority</option>
              <option value="CRITICAL_SITE">Critical Site</option>
            </select>
 
            {/* Hold Toggle */}
            <button
              onClick={() => setHoldOnlyFilter(!holdOnlyFilter)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors inline-flex items-center gap-1 cursor-pointer ${
                holdOnlyFilter
                  ? 'bg-amber-600 text-white border-amber-600'
                  : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
              }`}
            >
              <PauseCircle className="h-3 w-3" />
              <span>Holds Only</span>
            </button>
          </div>
        </div>
      </div>

      {/* Order Table */}
      <div className="bg-white border border-slate-200/90 rounded-lg overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[840px]">
            <thead className="bg-slate-50/80 text-slate-500 text-[11px] font-semibold uppercase tracking-wider border-b border-slate-200/80">
              <tr>
                <th className="px-4 py-3 w-44">Order</th>
                <th className="px-4 py-3 w-48">Customer & Area</th>
                <th className="px-4 py-3">Store Hub</th>
                <th className="px-4 py-3 w-36">Rider</th>
                <th className="px-4 py-3 w-36">Status & OTP</th>
                <th className="px-4 py-3 text-right w-28">Total</th>
                <th className="px-4 py-3 text-right w-24 pr-4">Control</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-400">
                    <RefreshCw className="h-4 w-4 animate-spin mx-auto text-[#009DE0] mb-1.5" />
                    <span>Loading orders...</span>
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-400">
                    No orders match your filter criteria.
                  </td>
                </tr>
              ) : (
                orders.map((ord) => (
                  <tr key={ord.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-slate-900 font-mono text-xs">{ord.orderNumber}</span>
                        {ord.isHold && (
                          <span className="bg-amber-100 text-amber-800 text-[9px] font-bold px-1 rounded">
                            HOLD
                          </span>
                        )}
                        {ord.priority === 'CRITICAL_SITE' && (
                          <span className="bg-rose-100 text-rose-800 text-[9px] font-bold px-1 rounded">
                            HOT
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">{ord.placedAt}</div>
                    </td>

                    <td className="px-4 py-3.5">
                      <div className="font-medium text-slate-900 truncate max-w-[170px]">{ord.customer.name}</div>
                      <div className="text-[11px] text-slate-400 truncate max-w-[170px] mt-0.5">
                        {ord.deliveryLocation?.areaName || 'Standard Location'}
                      </div>
                    </td>

                    <td className="px-4 py-3.5 max-w-xs">
                      <div className="font-medium text-slate-800 truncate">{ord.seller.name}</div>
                      <div className="text-[11px] text-slate-400 truncate mt-0.5">{ord.seller.hubType}</div>
                    </td>

                    <td className="px-4 py-3.5 whitespace-nowrap">
                      {ord.rider ? (
                        <div className="flex items-center gap-1.5">
                          <Bike className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                          <span className="font-medium text-slate-800 text-xs">{ord.rider.name}</span>
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded font-medium border border-amber-200/60">
                          <AlertTriangle className="h-3 w-3" />
                          Unassigned
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <div>{getStatusBadge(ord.status)}</div>
                      <div className="text-[10px] text-slate-500 flex items-center gap-1 mt-0.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${ord.status === 'delivered' ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                        <span>{ord.status === 'delivered' ? 'OTP Verified' : 'OTP Pending'}</span>
                      </div>
                    </td>

                    <td className="px-4 py-3.5 text-right font-mono whitespace-nowrap">
                      <div className="font-semibold text-slate-900 text-sm">₹{ord.pricing.total.toLocaleString('en-IN')}</div>
                      <div className="text-[10px] text-slate-500">{ord.items.length} {ord.items.length === 1 ? 'item' : 'items'}</div>
                    </td>

                    <td className="px-4 py-3.5 text-right whitespace-nowrap pr-4">
                      <button
                        onClick={() => setSelectedOrder(ord)}
                        className="text-slate-700 bg-white hover:bg-slate-50 hover:text-slate-950 border border-slate-200/90 px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.02)] transition-all cursor-pointer"
                      >
                        <Eye className="h-3.5 w-3.5 text-slate-400" />
                        <span>Manage</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Order Detail & Management Modal */}
      {selectedOrder && (
        <OrderDetailModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onRefresh={() => {
            fetchOrders();
            const updated = orders.find((o) => o.id === selectedOrder.id);
            if (updated) setSelectedOrder(updated);
          }}
          availableRiders={riders.filter((r) => r.status === 'ONLINE')}
          canEditStatus={canEditStatus}
          canCancel={canCancel}
          canAssignRider={canAssignRider}
        />
      )}
    </div>
  );
};

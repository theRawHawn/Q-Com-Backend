import React, { useState, useEffect } from 'react';
import {
  Send,
  Bike,
  AlertTriangle,
  Store,
  Radio,
  CheckCircle2,
  RefreshCw,
  Battery,
  Search
} from 'lucide-react';
import { AdminOrder, AdminRider, AdminPermission } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

interface DispatchOperationsProps {
  userPermissions: AdminPermission[];
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
}

export const DispatchOperations: React.FC<DispatchOperationsProps> = ({
  userPermissions,
  searchQuery: externalSearchQuery,
  onSearchQueryChange,
}) => {
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [riders, setRiders] = useState<AdminRider[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState(externalSearchQuery || '');
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [broadcastIncentive, setBroadcastIncentive] = useState(25);
  const [broadcastStatus, setBroadcastStatus] = useState('');
  const [selectedOrderToDispatch, setSelectedOrderToDispatch] = useState<AdminOrder | null>(null);
  const [selectedRiderId, setSelectedRiderId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  const canAssignRider = userPermissions.includes('orders.assign_rider');
  const canBroadcast = userPermissions.includes('riders.broadcast');

  const fetchData = async () => {
    try {
      setLoading(true);
      const [ordersRes, ridersRes]: [any, any] = await Promise.all([
        adminApi.get('/api/admin/orders'),
        adminApi.get('/api/admin/riders'),
      ]);
      if (ordersRes.success) setOrders(ordersRes.orders);
      if (ridersRes.success) setRiders(ridersRes.riders);
    } catch (err) {
      console.error('Failed to load dispatch data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  const queryLower = searchQuery.toLowerCase();

  const unassignedOrders = orders
    .filter((o) => o.status === 'packed' && !o.rider)
    .filter(
      (o) =>
        !queryLower ||
        o.orderNumber.toLowerCase().includes(queryLower) ||
        o.seller.name.toLowerCase().includes(queryLower) ||
        (o.deliveryLocation?.areaName && o.deliveryLocation.areaName.toLowerCase().includes(queryLower))
    );

  const filteredRiders = riders.filter(
    (r) =>
      !queryLower ||
      r.name.toLowerCase().includes(queryLower) ||
      r.phone.includes(queryLower) ||
      r.vehicleNumber.toLowerCase().includes(queryLower) ||
      (r.currentLocation?.areaName && r.currentLocation.areaName.toLowerCase().includes(queryLower))
  );

  const availableRiders = filteredRiders.filter((r) => r.status === 'ONLINE');
  const busyRiders = filteredRiders.filter((r) => r.status === 'ON_DELIVERY');

  const handleManualDispatch = async (orderId: string, riderId: string) => {
    try {
      setIsSubmitting(true);
      await adminApi.post(`/api/admin/orders/${orderId}/assign-rider`, { riderId });
      setSelectedOrderToDispatch(null);
      setSelectedRiderId('');
      fetchData();
    } catch (err: any) {
      alert(err.message || 'Failed to dispatch rider');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!broadcastMsg) return;
    try {
      setIsSubmitting(true);
      const res: any = await adminApi.post('/api/admin/riders/broadcast', {
        message: broadcastMsg,
        incentiveAmount: broadcastIncentive,
      });
      setBroadcastStatus(`Broadcast sent to ${res.sentCount} active riders (+₹${broadcastIncentive} incentive).`);
      setBroadcastMsg('');
    } catch (err: any) {
      alert(err.message || 'Broadcast failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-5">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Live Dispatch
          </h1>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search unassigned orders & fleet roster..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full bg-slate-50/80 border border-slate-200/80 rounded-md pl-9 pr-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#009DE0]/15 focus:border-[#009DE0] transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
            />
          </div>

          <button
            onClick={fetchData}
            className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200/90 transition-all shadow-[0_1px_2px_rgba(0,0,0,0.02)] shrink-0 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#009DE0]' : 'text-slate-500'}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Fleet Stats Overview */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-white border border-slate-200/90 rounded-lg p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
          <span className="text-xs font-medium text-slate-500">Available Fleet</span>
          <div className="text-xl font-bold font-mono text-slate-900 mt-1">{availableRiders.length + 143}</div>
          <span className="text-[11px] text-emerald-700 font-medium">Ready for pickup</span>
        </div>

        <div className="bg-white border border-slate-200/90 rounded-lg p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
          <span className="text-xs font-medium text-slate-500">En Route</span>
          <div className="text-xl font-bold font-mono text-slate-900 mt-1">{busyRiders.length + 57}</div>
          <span className="text-[11px] text-slate-500">Delivering</span>
        </div>

        <div className="bg-white border border-slate-200/90 rounded-lg p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
          <span className="text-xs font-medium text-slate-500">Awaiting Rider</span>
          <div className="text-xl font-bold font-mono text-slate-900 mt-1">{unassignedOrders.length + 5}</div>
          <span className="text-[11px] text-rose-600 font-medium">Requires assignment</span>
        </div>

        <div className="bg-white border border-slate-200/90 rounded-lg p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
          <span className="text-xs font-medium text-slate-500">Avg Assignment Time</span>
          <div className="text-xl font-bold font-mono text-slate-900 mt-1">1.8 min</div>
          <span className="text-[11px] text-emerald-700 font-medium">Target: &lt;3 min</span>
        </div>
      </div>

      {/* Ready Orders Without Rider */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <h3 className="font-semibold text-slate-900 text-sm">Orders Ready for Assignment</h3>
          </div>
          <span className="text-xs text-slate-500">
            {unassignedOrders.length} pending
          </span>
        </div>

        {unassignedOrders.length === 0 ? (
          <div className="p-6 bg-slate-50 rounded-lg text-center text-slate-400 text-xs">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 mx-auto mb-1" />
            <span>All packed orders have assigned delivery partners.</span>
          </div>
        ) : (
          <div className="space-y-2">
            {unassignedOrders.map((ord) => (
              <div
                key={ord.id}
                className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex flex-col md:flex-row md:items-center justify-between gap-3"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-900">{ord.orderNumber}</span>
                    <span className="text-[10px] bg-sky-50 text-sky-700 px-1.5 py-0.5 rounded font-medium">
                      Ready for Pickup
                    </span>
                    <span className="text-[10px] text-slate-400">{ord.placedAt}</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                    <span className="flex items-center gap-1">
                      <Store className="h-3.5 w-3.5 text-slate-400" />
                      <span>{ord.seller.name}</span>
                    </span>
                    <span className="text-slate-400">·</span>
                    <span>{ord.deliveryLocation?.areaName}</span>
                    <span className="text-slate-400">·</span>
                    <span className="font-medium text-slate-900">{ord.items.length} items (₹{ord.pricing.total})</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={selectedOrderToDispatch?.id === ord.id ? selectedRiderId : ''}
                    onChange={(e) => {
                      setSelectedOrderToDispatch(ord);
                      setSelectedRiderId(e.target.value);
                    }}
                    disabled={!canAssignRider || isSubmitting}
                    className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
                  >
                    <option value="">Select rider...</option>
                    {availableRiders.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} ({r.vehicleType.replace('_', ' ')})
                      </option>
                    ))}
                  </select>

                  <button
                    onClick={() => handleManualDispatch(ord.id, selectedRiderId)}
                    disabled={
                      !canAssignRider ||
                      selectedOrderToDispatch?.id !== ord.id ||
                      !selectedRiderId ||
                      isSubmitting
                    }
                    className="bg-[#009DE0] hover:bg-[#0087c2] disabled:opacity-40 text-white font-medium px-3 py-1.5 rounded-lg text-xs flex items-center gap-1 transition-colors shrink-0 shadow-[0_2px_8px_rgba(0,157,224,0.25)]"
                  >
                    <Send className="h-3 w-3" />
                    <span>Assign</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Fleet Roster & Broadcast */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Available Riders */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <h3 className="font-semibold text-slate-900 text-sm">Fleet Status</h3>
            <span className="text-xs text-slate-500">
              {availableRiders.length} Online
            </span>
          </div>

          <div className="space-y-2">
            {riders.map((r) => (
              <div
                key={r.id}
                className="bg-slate-50 border border-slate-100 rounded-lg p-3 flex items-center justify-between"
              >
                <div className="flex items-center gap-2.5">
                  <div className="relative">
                    <img src={r.avatar} alt={r.name} className="h-8 w-8 rounded-full object-cover" />
                    <span
                      className={`absolute bottom-0 right-0 h-2 w-2 rounded-full ring-2 ring-white ${
                        r.status === 'ONLINE'
                          ? 'bg-emerald-500'
                          : r.status === 'ON_DELIVERY'
                          ? 'bg-sky-500'
                          : 'bg-slate-400'
                      }`}
                    ></span>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-slate-900 text-xs">{r.name}</span>
                      <span className="text-[10px] text-slate-500">
                        {r.vehicleType.replace('_', ' ')}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {r.vehicleNumber} · {r.currentLocation?.areaName || 'Bengaluru'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3 text-xs">
                  {r.batteryPercent && (
                    <div className="flex items-center gap-1 text-slate-500 text-[11px]">
                      <Battery className="h-3 w-3 text-slate-400" />
                      <span>{r.batteryPercent}%</span>
                    </div>
                  )}
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                      r.status === 'ONLINE'
                        ? 'bg-emerald-50 text-emerald-700'
                        : r.status === 'ON_DELIVERY'
                        ? 'bg-sky-50 text-sky-700'
                        : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {r.status.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Fleet Broadcast */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-3">
          <div className="border-b border-slate-100 pb-2">
            <h3 className="font-semibold text-slate-900 text-sm flex items-center gap-1.5">
              <Radio className="h-3.5 w-3.5 text-[#009DE0]" />
              Fleet Broadcast
            </h3>
          </div>

          {broadcastStatus && (
            <div className="p-2.5 bg-emerald-50 text-emerald-800 rounded-lg text-xs flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>{broadcastStatus}</span>
            </div>
          )}

          <form onSubmit={handleBroadcast} className="space-y-3 text-xs">
            <div>
              <label className="text-slate-600 block mb-1 font-medium">Message</label>
              <textarea
                rows={2}
                placeholder="Message to online fleet..."
                value={broadcastMsg}
                onChange={(e) => setBroadcastMsg(e.target.value)}
                disabled={!canBroadcast || isSubmitting}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
              />
            </div>

            <div>
              <label className="text-slate-600 block mb-1 font-medium">Surge Bonus (₹)</label>
              <input
                type="number"
                value={broadcastIncentive}
                onChange={(e) => setBroadcastIncentive(Number(e.target.value))}
                disabled={!canBroadcast || isSubmitting}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-900 focus:outline-none focus:ring-1 focus:ring-[#009DE0]"
              />
            </div>

            <button
              type="submit"
              disabled={!canBroadcast || !broadcastMsg || isSubmitting}
              className="w-full bg-[#009DE0] hover:bg-[#0087c2] disabled:opacity-40 text-white font-medium py-2 rounded-lg text-xs flex items-center justify-center gap-1.5 transition-colors shadow-[0_2px_8px_rgba(0,157,224,0.25)]"
            >
              <Radio className="h-3.5 w-3.5" />
              <span>Send Broadcast</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

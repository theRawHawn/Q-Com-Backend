import React, { useState } from 'react';
import { 
  Clock, 
  MapPin, 
  User, 
  Phone, 
  Package, 
  Bike, 
  CheckCircle2, 
  Printer, 
  Sparkles, 
  AlertCircle, 
  ArrowRight,
  ShieldCheck,
  Zap,
  Building2,
  KeyRound
} from 'lucide-react';
import { Order, OrderStatus, EVRider } from '../../types';

interface LiveOrderQueueProps {
  orders: Order[];
  onUpdateOrderStatus: (orderId: string, newStatus: OrderStatus) => void;
  riders: EVRider[];
  onAssignRider: (orderId: string, riderId: string) => void;
  onSimulateOrder: () => void;
}

export const LiveOrderQueue: React.FC<LiveOrderQueueProps> = ({
  orders,
  onUpdateOrderStatus,
  riders,
  onAssignRider,
  onSimulateOrder,
}) => {
  const [selectedStatusTab, setSelectedStatusTab] = useState<'all' | 'incoming' | 'picking' | 'dispatched' | 'delivered'>('all');
  const [selectedOrderForSlip, setSelectedOrderForSlip] = useState<Order | null>(null);

  // Filter orders
  const filteredOrders = orders.filter(order => {
    if (selectedStatusTab === 'all') return true;
    if (selectedStatusTab === 'incoming') return order.status === 'placed';
    if (selectedStatusTab === 'picking') return order.status === 'picking' || order.status === 'packed';
    if (selectedStatusTab === 'dispatched') return order.status === 'out_for_delivery' || order.status === 'arriving';
    if (selectedStatusTab === 'delivered') return order.status === 'delivered';
    return true;
  });

  const getStatusBadge = (status: OrderStatus) => {
    switch (status) {
      case 'placed':
        return <span className="bg-amber-100 text-amber-900 border border-amber-300 text-[10px] font-black px-2 py-0.5 rounded-full animate-pulse">⚡ NEW INCOMING</span>;
      case 'picking':
        return <span className="bg-blue-100 text-blue-900 border border-blue-300 text-[10px] font-black px-2 py-0.5 rounded-full">📦 PICKING IN BINS</span>;
      case 'packed':
        return <span className="bg-purple-100 text-purple-900 border border-purple-300 text-[10px] font-black px-2 py-0.5 rounded-full">🛍️ READY AT DISPATCH</span>;
      case 'out_for_delivery':
      case 'arriving':
        return <span className="bg-emerald-100 text-emerald-900 border border-emerald-300 text-[10px] font-black px-2 py-0.5 rounded-full">🛵 ON EV DELIVERY</span>;
      case 'delivered':
        return <span className="bg-slate-100 text-slate-700 border border-slate-300 text-[10px] font-bold px-2 py-0.5 rounded-full">✅ DELIVERED</span>;
    }
  };

  return (
    <div className="space-y-4">
      
      {/* Top Controls & Status Filters */}
      <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-2xs flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto text-xs font-bold">
          
          <button
            onClick={() => setSelectedStatusTab('all')}
            className={`px-3 py-1.5 rounded-xl transition cursor-pointer ${
              selectedStatusTab === 'all'
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            All Orders ({orders.length})
          </button>

          <button
            onClick={() => setSelectedStatusTab('incoming')}
            className={`px-3 py-1.5 rounded-xl transition cursor-pointer flex items-center gap-1.5 ${
              selectedStatusTab === 'incoming'
                ? 'bg-amber-500 text-slate-950 font-black'
                : 'bg-amber-50 text-amber-800 hover:bg-amber-100'
            }`}
          >
            <span>⚡ Incoming</span>
            <span className="bg-amber-200 text-amber-950 text-[10px] px-1.5 py-0.2 rounded-full font-black">
              {orders.filter(o => o.status === 'placed').length}
            </span>
          </button>

          <button
            onClick={() => setSelectedStatusTab('picking')}
            className={`px-3 py-1.5 rounded-xl transition cursor-pointer flex items-center gap-1.5 ${
              selectedStatusTab === 'picking'
                ? 'bg-blue-600 text-white font-black'
                : 'bg-blue-50 text-blue-800 hover:bg-blue-100'
            }`}
          >
            <span>📦 Store Picking</span>
            <span className="bg-blue-200 text-blue-950 text-[10px] px-1.5 py-0.2 rounded-full font-black">
              {orders.filter(o => o.status === 'picking' || o.status === 'packed').length}
            </span>
          </button>

          <button
            onClick={() => setSelectedStatusTab('dispatched')}
            className={`px-3 py-1.5 rounded-xl transition cursor-pointer flex items-center gap-1.5 ${
              selectedStatusTab === 'dispatched'
                ? 'bg-emerald-700 text-white font-black'
                : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
            }`}
          >
            <span>🛵 On Road</span>
            <span className="bg-emerald-200 text-emerald-950 text-[10px] px-1.5 py-0.2 rounded-full font-black">
              {orders.filter(o => o.status === 'out_for_delivery' || o.status === 'arriving').length}
            </span>
          </button>

          <button
            onClick={() => setSelectedStatusTab('delivered')}
            className={`px-3 py-1.5 rounded-xl transition cursor-pointer ${
              selectedStatusTab === 'delivered'
                ? 'bg-slate-800 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Completed ({orders.filter(o => o.status === 'delivered').length})
          </button>

        </div>

        <div className="text-xs text-slate-500 font-medium flex items-center gap-2">
          <span>Dark Store Queue SLA: <strong className="text-emerald-700 font-black">98.6% On-Time</strong></span>
        </div>
      </div>

      {/* Orders Stream */}
      {filteredOrders.length === 0 ? (
        <div className="bg-white rounded-3xl border border-slate-200 p-12 text-center space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-slate-100 text-slate-400 mx-auto flex items-center justify-center">
            <Package className="w-8 h-8" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900">No active orders in this queue</h3>
            <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1">
              When customers order hardware items, orders will appear here for immediate 2-minute bin picking.
            </p>
          </div>
          <button
            onClick={onSimulateOrder}
            className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-4 py-2.5 rounded-xl transition cursor-pointer inline-flex items-center gap-1.5"
          >
            <Sparkles className="w-4 h-4" />
            <span>Generate Test Order</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filteredOrders.map((order) => {
            const orderTotalItems = order.items.reduce((s, i) => s + i.quantity, 0);

            return (
              <div 
                key={order.id}
                className="bg-white rounded-3xl border border-slate-200/90 shadow-sm p-4 sm:p-5 space-y-4 hover:border-emerald-500/40 transition-all flex flex-col justify-between"
              >
                {/* Card Top: Order ID, Status, Timestamp */}
                <div>
                  <div className="flex items-start justify-between gap-2 pb-3 border-b border-slate-100">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-black text-sm text-slate-950">#{order.id}</span>
                        {getStatusBadge(order.status)}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2">
                        <Clock className="w-3 h-3 text-slate-400" />
                        <span>Placed at {new Date(order.placedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        <span>•</span>
                        <span className="font-bold text-emerald-700">Target Delivery: Fast Dispatch SLA</span>
                      </div>
                    </div>

                    <button
                      onClick={() => setSelectedOrderForSlip(order)}
                      title="Print Pick Slip"
                      className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer text-xs flex items-center gap-1 font-bold"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Pick Slip</span>
                    </button>
                  </div>

                  {/* Jobsite Delivery Location Box */}
                  <div className="bg-slate-50 p-3 rounded-2xl border border-slate-200/80 my-3 text-xs space-y-1.5">
                    <div className="flex items-center justify-between font-bold text-slate-900">
                      <div className="flex items-center gap-1.5 truncate">
                        <Building2 className="w-4 h-4 text-emerald-700 shrink-0" />
                        <span className="truncate">{order.jobSite.jobTag}</span>
                      </div>
                      <span className="text-[10px] bg-emerald-100 text-emerald-900 px-2 py-0.5 rounded font-black">
                        {order.jobSite.tradeType}
                      </span>
                    </div>

                    <div className="text-[11px] text-slate-600 flex items-start gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                      <span>{order.jobSite.floorUnit} • {order.jobSite.address}</span>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1 border-t border-slate-200/50">
                      <div className="flex items-center gap-1">
                        <User className="w-3 h-3 text-slate-400" />
                        <span>{order.jobSite.siteContactName}</span>
                      </div>
                      <div className="flex items-center gap-1 font-mono">
                        <Phone className="w-3 h-3 text-slate-400" />
                        <span>{order.jobSite.sitePhone}</span>
                      </div>
                    </div>
                  </div>

                  {/* Dark Store Pick List with Bin Locations */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-wider text-slate-400">
                      <span>Dark Store Pick List ({orderTotalItems} items)</span>
                      <span>Bin Location</span>
                    </div>

                    <div className="bg-slate-50/70 rounded-2xl border border-slate-100 divide-y divide-slate-100 overflow-hidden text-xs">
                      {order.items.map(({ product, quantity }) => (
                        <div key={product.id} className="p-2.5 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 truncate">
                            {product.imageUrl ? (
                              <img 
                                src={product.imageUrl} 
                                alt={product.name}
                                referrerPolicy="no-referrer"
                                className="w-8 h-8 rounded-lg object-cover border border-slate-200 shrink-0" 
                              />
                            ) : null}
                            <div className="truncate">
                              <div className="font-bold text-slate-900 truncate">{product.name}</div>
                              <div className="text-[10px] text-slate-500">Qty: <strong>{quantity}x</strong> • ₹{product.price} each</div>
                            </div>
                          </div>

                          <div className="shrink-0 text-right">
                            <span className="font-mono font-black text-[10px] bg-amber-100 text-amber-900 border border-amber-200 px-2 py-0.5 rounded-md">
                              {product.binLocation}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Bill Summary & Payment Tag */}
                  <div className="flex items-center justify-between pt-3 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-bold">
                        {order.paymentMethod}
                      </span>
                      {order.clientInvoiceNeeded && (
                        <span className="text-[10px] bg-blue-50 text-blue-700 px-2 py-0.5 rounded font-bold">
                          GST Invoice
                        </span>
                      )}
                    </div>
                    <div className="font-black text-sm text-slate-900">
                      Total: ₹{order.total.toFixed(0)}
                    </div>
                  </div>
                </div>

                {/* Card Bottom: Dispatch Workflow Action Buttons */}
                <div className="pt-3 border-t border-slate-100 space-y-2">
                  
                  {/* Step 1: Placed -> Start Picking */}
                  {order.status === 'placed' && (
                    <button
                      onClick={() => onUpdateOrderStatus(order.id, 'picking')}
                      className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs py-2.5 rounded-xl shadow-xs transition flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <span>⚡ Accept & Assign Bay Picker</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  )}

                  {/* Step 2: Picking -> Mark Packed */}
                  {order.status === 'picking' && (
                    <button
                      onClick={() => onUpdateOrderStatus(order.id, 'packed')}
                      className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black text-xs py-2.5 rounded-xl shadow-xs transition flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Mark All Items Picked & Bagged</span>
                    </button>
                  )}

                  {/* Step 3: Packed -> Handover to EV Courier Rider */}
                  {order.status === 'packed' && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-[11px] font-bold text-slate-700">
                        <span className="flex items-center gap-1">
                          <Bike className="w-3.5 h-3.5 text-emerald-700" />
                          Assign EV Courier:
                        </span>
                        <span className="text-emerald-700 text-[10px]">Chetak EV Fleet</span>
                      </div>
                      <div className="flex gap-2">
                        <select 
                          className="flex-1 bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs font-bold text-slate-800"
                          defaultValue={order.rider.name}
                        >
                          {riders.map(r => (
                            <option key={r.id} value={r.name}>
                              {r.name} ({r.vehicle} - {r.batteryPercent}% 🔋)
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => onUpdateOrderStatus(order.id, 'out_for_delivery')}
                          className="bg-emerald-700 hover:bg-emerald-800 text-white font-black text-xs px-4 py-2 rounded-xl transition cursor-pointer flex items-center gap-1"
                        >
                          <span>Dispatch 🛵</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Step 4: On Delivery -> Verify OTP / Delivered */}
                  {(order.status === 'out_for_delivery' || order.status === 'arriving') && (
                    <div className="bg-emerald-50 p-2.5 rounded-xl border border-emerald-200 flex items-center justify-between text-xs">
                      <div>
                        <div className="font-bold text-emerald-950 flex items-center gap-1">
                          <Bike className="w-3.5 h-3.5 text-emerald-700" />
                          <span>Rider: {order.rider.name} ({order.rider.vehicle})</span>
                        </div>
                        <div className="text-[10px] text-emerald-700 font-mono mt-0.5">
                          Delivery OTP: <strong>{order.deliveryOtp}</strong>
                        </div>
                      </div>
                      <button
                        onClick={() => onUpdateOrderStatus(order.id, 'delivered')}
                        className="bg-emerald-700 hover:bg-emerald-800 text-white font-black text-[11px] px-3 py-1.5 rounded-lg transition cursor-pointer"
                      >
                        Confirm Delivered
                      </button>
                    </div>
                  )}

                  {/* Step 5: Delivered */}
                  {order.status === 'delivered' && (
                    <div className="text-center py-1 text-xs text-slate-500 font-medium flex items-center justify-center gap-1">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      <span>Order Delivered to {order.jobSite.floorUnit}</span>
                    </div>
                  )}

                </div>

              </div>
            );
          })}
        </div>
      )}

      {/* Pick Slip Modal for thermal print preview */}
      {selectedOrderForSlip && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-3xl max-w-sm w-full p-5 shadow-2xl space-y-4 border border-slate-200 font-mono text-xs text-slate-900">
            <div className="text-center pb-3 border-b border-dashed border-slate-300">
              <div className="font-black text-sm">QUICK HARDWARE MERCHANT FULFILLMENT</div>
              <div className="text-[10px] text-slate-500">EXPRESS JOBSITE PICK SLIP</div>
              <div className="text-xs font-black mt-1">ORDER #{selectedOrderForSlip.id}</div>
            </div>

            <div className="space-y-1 text-[11px]">
              <div><strong>Client / Tag:</strong> {selectedOrderForSlip.jobSite.jobTag}</div>
              <div><strong>Floor Drop:</strong> {selectedOrderForSlip.jobSite.floorUnit}</div>
              <div><strong>Contact:</strong> {selectedOrderForSlip.jobSite.siteContactName} ({selectedOrderForSlip.jobSite.sitePhone})</div>
            </div>

            <div className="border-t border-b border-dashed border-slate-300 py-2 space-y-1.5">
              <div className="font-bold text-[10px] uppercase">PICK ITEMS FROM AISLE BINS:</div>
              {selectedOrderForSlip.items.map(({ product, quantity }) => (
                <div key={product.id} className="flex justify-between items-start text-[11px]">
                  <div className="flex-1 pr-2">
                    <span className="font-bold">{quantity}x</span> {product.name}
                  </div>
                  <div className="font-black bg-slate-100 px-1.5 py-0.5 rounded text-[10px]">
                    {product.binLocation}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-between items-center text-xs font-bold pt-1">
              <span>Total Bill:</span>
              <span>₹{selectedOrderForSlip.total.toFixed(0)}</span>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setSelectedOrderForSlip(null)}
                className="flex-1 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 font-bold cursor-pointer"
              >
                Close
              </button>
              <button
                onClick={() => {
                  window.print();
                  setSelectedOrderForSlip(null);
                }}
                className="flex-1 py-2 rounded-xl bg-emerald-700 text-white hover:bg-emerald-800 font-black cursor-pointer"
              >
                Print Slip
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

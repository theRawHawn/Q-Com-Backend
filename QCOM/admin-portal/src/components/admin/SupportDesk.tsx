import React, { useState, useEffect } from 'react';
import {
  LifeBuoy,
  Search,
  RefreshCw,
  Filter,
  CheckCircle2,
  Clock,
  AlertCircle,
  MessageSquare,
  User,
  Plus,
  Send,
  ShieldAlert,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';
import { AdminPermission, SupportTicket } from '../../types/admin';
import { adminApi } from '../../utils/adminApiClient';

interface SupportDeskProps {
  userPermissions: AdminPermission[];
}

export const SupportDesk: React.FC<SupportDeskProps> = ({ userPermissions }) => {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'>('ALL');
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);
  const [responseNote, setResponseNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // New ticket modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTicketData, setNewTicketData] = useState({
    raisedByName: '',
    raisedByType: 'CUSTOMER' as const,
    category: 'DELIVERY_DELAY' as const,
    priority: 'MEDIUM' as const,
    subject: '',
    description: '',
    orderNumber: '',
  });

  const canEdit = userPermissions.includes('support.update_ticket') || userPermissions.includes('support.manage');
  const canResolve = userPermissions.includes('support.resolve_ticket') || userPermissions.includes('support.manage');
  const canCreate = userPermissions.includes('support.create_ticket') || userPermissions.includes('support.manage');

  const fetchTickets = async () => {
    try {
      setLoading(true);
      const res: any = await adminApi.get('/api/admin/support/tickets');
      if (res.success) {
        setTickets(res.tickets || []);
        if (selectedTicket) {
          const updated = (res.tickets || []).find((t: SupportTicket) => t.id === selectedTicket.id);
          if (updated) setSelectedTicket(updated);
        }
      }
    } catch (err) {
      console.error('Failed to load support tickets:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTickets();
  }, []);

  const handleUpdateStatus = async (ticketId: string, status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED') => {
    try {
      setIsSubmitting(true);
      await adminApi.post(`/api/admin/support/tickets/${ticketId}/update`, {
        status,
        resolutionNotes: responseNote ? responseNote : undefined,
      });
      setResponseNote('');
      await fetchTickets();
    } catch (err: any) {
      alert(err.message || 'Failed to update ticket');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSubmitting(true);
      await adminApi.post('/api/admin/support/tickets/create', newTicketData);
      setShowCreateModal(false);
      setNewTicketData({
        raisedByName: '',
        raisedByType: 'CUSTOMER',
        category: 'DELIVERY_DELAY',
        priority: 'MEDIUM',
        subject: '',
        description: '',
        orderNumber: '',
      });
      await fetchTickets();
    } catch (err: any) {
      alert(err.message || 'Failed to create ticket');
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredTickets = tickets.filter((t) => {
    const matchesStatus = statusFilter === 'ALL' || t.status === statusFilter;
    const q = searchQuery.toLowerCase();
    const matchesQuery =
      !searchQuery ||
      t.ticketNumber.toLowerCase().includes(q) ||
      t.subject.toLowerCase().includes(q) ||
      t.raisedByName.toLowerCase().includes(q) ||
      (t.orderNumber && t.orderNumber.toLowerCase().includes(q));
    return matchesStatus && matchesQuery;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2.5">
            <LifeBuoy className="w-7 h-7 text-primary" />
            Support & Grievance Operations
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Resolve contractor disputes, delivery delays, defective items, and partner merchant inquiries.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchTickets}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          {canCreate && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-white bg-primary hover:bg-primary/90 rounded-lg shadow-sm transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Ticket
            </button>
          )}
        </div>
      </div>

      {/* Main Grid: Ticket List + Selected Ticket Detail */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Tickets List */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-3">
            {/* Search & Filter */}
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search ticket #, subject, order..."
                className="w-full pl-9 pr-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
            </div>

            {/* Status Pills */}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {(['ALL', 'OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const).map((st) => (
                <button
                  key={st}
                  onClick={() => setStatusFilter(st)}
                  className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
                    statusFilter === st
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {st.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>

          {/* Tickets List */}
          <div className="space-y-2.5 max-h-[600px] overflow-y-auto">
            {loading ? (
              <div className="p-8 text-center text-xs text-slate-500">Loading support tickets...</div>
            ) : filteredTickets.length === 0 ? (
              <div className="p-8 text-center bg-white rounded-xl border border-slate-200 text-xs text-slate-500">
                No tickets matching criteria.
              </div>
            ) : (
              filteredTickets.map((t) => {
                const isSelected = selectedTicket?.id === t.id;
                return (
                  <div
                    key={t.id}
                    onClick={() => setSelectedTicket(t)}
                    className={`p-4 bg-white rounded-xl border cursor-pointer transition-all ${
                      isSelected
                        ? 'border-primary shadow-md ring-1 ring-primary'
                        : 'border-slate-200 hover:border-slate-300 shadow-sm'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="text-xs font-bold text-primary font-mono">{t.ticketNumber}</span>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          t.status === 'OPEN'
                            ? 'bg-amber-100 text-amber-800'
                            : t.status === 'IN_PROGRESS'
                            ? 'bg-blue-100 text-blue-800'
                            : t.status === 'RESOLVED'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {t.status}
                      </span>
                    </div>
                    <div className="text-xs font-bold text-slate-900 line-clamp-1 mb-1">{t.subject}</div>
                    <p className="text-[11px] text-slate-500 line-clamp-2 mb-2">{t.description}</p>
                    <div className="flex items-center justify-between text-[10px] text-slate-400">
                      <span>{t.raisedByName}</span>
                      <span>{t.createdAt}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Ticket Detail View */}
        <div className="lg:col-span-7">
          {selectedTicket ? (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-6">
              <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-bold text-primary">{selectedTicket.ticketNumber}</span>
                    <span
                      className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                        selectedTicket.status === 'OPEN'
                          ? 'bg-amber-100 text-amber-800'
                          : selectedTicket.status === 'IN_PROGRESS'
                          ? 'bg-blue-100 text-blue-800'
                          : selectedTicket.status === 'RESOLVED'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {selectedTicket.status}
                    </span>
                    <span
                      className={`text-xs font-bold px-2 py-0.5 rounded ${
                        selectedTicket.priority === 'CRITICAL' || selectedTicket.priority === 'HIGH'
                          ? 'bg-rose-100 text-rose-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {selectedTicket.priority} Priority
                    </span>
                  </div>
                  <h2 className="text-lg font-bold text-slate-900 mt-1">{selectedTicket.subject}</h2>
                </div>
              </div>

              {/* Meta information */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 bg-slate-50 rounded-lg text-xs">
                <div>
                  <div className="text-[10px] text-slate-400 font-semibold uppercase">Raised By</div>
                  <div className="font-bold text-slate-800 mt-0.5">{selectedTicket.raisedByName}</div>
                  <div className="text-[10px] text-slate-500">({selectedTicket.raisedByType})</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 font-semibold uppercase">Category</div>
                  <div className="font-bold text-slate-800 mt-0.5">{selectedTicket.category.replace('_', ' ')}</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 font-semibold uppercase">Order Ref</div>
                  <div className="font-bold text-slate-800 font-mono mt-0.5">
                    {selectedTicket.orderNumber || 'N/A'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 font-semibold uppercase">Created</div>
                  <div className="font-bold text-slate-800 mt-0.5">{selectedTicket.createdAt}</div>
                </div>
              </div>

              {/* Description */}
              <div>
                <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Description / Issue Log</h4>
                <div className="p-4 bg-slate-50 rounded-lg text-xs text-slate-700 leading-relaxed border border-slate-100">
                  {selectedTicket.description}
                </div>
              </div>

              {/* Resolution Notes if resolved */}
              {selectedTicket.resolutionNotes && (
                <div>
                  <h4 className="text-xs font-bold text-emerald-700 uppercase tracking-wider mb-2">
                    Resolution Notes
                  </h4>
                  <div className="p-4 bg-emerald-50 rounded-lg text-xs text-emerald-800 leading-relaxed border border-emerald-200">
                    {selectedTicket.resolutionNotes}
                  </div>
                </div>
              )}

              {/* Actions */}
              {canEdit && (
                <div className="pt-4 border-t border-slate-100 space-y-3">
                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                    Staff Response & Resolution
                  </h4>
                  <textarea
                    rows={3}
                    value={responseNote}
                    onChange={(e) => setResponseNote(e.target.value)}
                    placeholder="Enter internal resolution notes or customer response message..."
                    className="w-full p-3 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    {selectedTicket.status !== 'IN_PROGRESS' && (
                      <button
                        disabled={isSubmitting}
                        onClick={() => handleUpdateStatus(selectedTicket.id, 'IN_PROGRESS')}
                        className="px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                      >
                        Mark In-Progress
                      </button>
                    )}
                    {canResolve && selectedTicket.status !== 'RESOLVED' && (
                      <button
                        disabled={isSubmitting}
                        onClick={() => handleUpdateStatus(selectedTicket.id, 'RESOLVED')}
                        className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors"
                      >
                        Resolve Ticket
                      </button>
                    )}
                    {selectedTicket.status !== 'CLOSED' && (
                      <button
                        disabled={isSubmitting}
                        onClick={() => handleUpdateStatus(selectedTicket.id, 'CLOSED')}
                        className="px-3 py-2 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                      >
                        Close Ticket
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400">
              <LifeBuoy className="w-12 h-12 mx-auto stroke-1 mb-2 text-slate-300" />
              <p className="text-sm font-medium">Select a ticket from the left queue to view details.</p>
            </div>
          )}
        </div>
      </div>

      {/* New Ticket Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-slate-900">Create Manual Support Ticket</h3>
            <form onSubmit={handleCreateTicket} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Raised By Name *</label>
                <input
                  required
                  type="text"
                  value={newTicketData.raisedByName}
                  onChange={(e) => setNewTicketData({ ...newTicketData, raisedByName: e.target.value })}
                  placeholder="e.g. Ramesh Patil"
                  className="w-full px-3 py-2 text-xs border rounded-lg"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Raised By Party</label>
                  <select
                    value={newTicketData.raisedByType}
                    onChange={(e) => setNewTicketData({ ...newTicketData, raisedByType: e.target.value as any })}
                    className="w-full px-3 py-2 text-xs border rounded-lg"
                  >
                    <option value="CUSTOMER">Customer</option>
                    <option value="CONTRACTOR">Contractor</option>
                    <option value="SELLER">Seller Merchant</option>
                    <option value="RIDER">Delivery Partner</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Priority</label>
                  <select
                    value={newTicketData.priority}
                    onChange={(e) => setNewTicketData({ ...newTicketData, priority: e.target.value as any })}
                    className="w-full px-3 py-2 text-xs border rounded-lg"
                  >
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                    <option value="CRITICAL">Critical</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Category</label>
                <select
                  value={newTicketData.category}
                  onChange={(e) => setNewTicketData({ ...newTicketData, category: e.target.value as any })}
                  className="w-full px-3 py-2 text-xs border rounded-lg"
                >
                  <option value="DELIVERY_DELAY">Delivery Delay</option>
                  <option value="DAMAGED_ITEM">Damaged / Defective Item</option>
                  <option value="PAYMENT_ISSUE">Payment / Refund Issue</option>
                  <option value="SELLER_DISPUTE">Merchant Store Issue</option>
                  <option value="RIDER_BEHAVIOR">Rider Dispatch Issue</option>
                  <option value="TECHNICAL_BUG">App / Technical Bug</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Subject *</label>
                <input
                  required
                  type="text"
                  value={newTicketData.subject}
                  onChange={(e) => setNewTicketData({ ...newTicketData, subject: e.target.value })}
                  placeholder="Summary of grievance"
                  className="w-full px-3 py-2 text-xs border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Description *</label>
                <textarea
                  required
                  rows={3}
                  value={newTicketData.description}
                  onChange={(e) => setNewTicketData({ ...newTicketData, description: e.target.value })}
                  placeholder="Detailed description of issue..."
                  className="w-full px-3 py-2 text-xs border rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 text-xs font-bold text-white bg-primary hover:bg-primary/90 rounded-lg"
                >
                  Create Ticket
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

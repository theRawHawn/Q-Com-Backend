export type RiderState =
  | 'OFFLINE'
  | 'IDLE_AT_HUB'
  | 'AVAILABLE'
  | 'OFFERED'
  | 'ASSIGNED'
  | 'PICKING_UP'
  | 'IN_TRANSIT'
  | 'ON_TRIP'
  | 'ARRIVED_AT_DROP'
  | 'UNAVAILABLE'
  | 'SUSPENDED';

export type AssignmentState =
  | 'CREATED'
  | 'OFFERED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'COMPLETED';

export type OfferState =
  | 'OFFERED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED';

export interface RiderCandidate {
  riderId: string;
  riderCode: string;
  name: string;
  phone: string;
  vehicleType: string;
  payloadCapacityKg: number;
  rating: number;
  tier: string;
  status: RiderState;
  latitude: number;
  longitude: number;
  distanceToStoreMeters: number;
  etaToStoreMinutes: number;
  payoutAmountInr: number;
  isEconomicallyViable: boolean;
  score?: number;
}

export interface DispatchCandidateContext {
  orderId: string;
  merchantId: string;
  storeLocation: { latitude: number; longitude: number };
  customerLocation: { latitude: number; longitude: number };
  totalWeightKg?: number;
  predictedReadyAt?: string;
  actualReadyAt?: string;
  itemsSubtotal: number;
  customerDeliveryFee: number;
  handlingFee: number;
  excludeRiderIds?: string[];
}

export interface DispatchScoringResult {
  candidate: RiderCandidate;
  score: number;
  breakdown: {
    etaScore: number;
    distanceScore: number;
    ratingScore: number;
    capacityScore: number;
    economicScore: number;
  };
}

export interface DispatchAssignmentRecord {
  id: string;
  orderId: string;
  deliveryTripId?: string;
  riderId: string;
  status: AssignmentState;
  scoringSnapshot: any;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchOfferRecord {
  id: string;
  assignmentId: string;
  riderId: string;
  orderId: string;
  status: OfferState;
  rejectionReason?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface DomainEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  payload: any;
}

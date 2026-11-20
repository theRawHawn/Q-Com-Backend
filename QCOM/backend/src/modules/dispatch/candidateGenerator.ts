import { getPool } from '../../database/connection.js';
import { routingService } from '../routing/routingService.js';
import { deliveryEconomicsService } from '../delivery/deliveryEconomicsService.js';
import { liveLocationService } from '../realtime/liveLocationService.js';
import { DispatchCandidateContext, RiderCandidate } from './dispatchTypes.js';

const DEFAULT_MAX_GPS_STALENESS_MS = 10 * 60 * 1000; // 10 minutes

export function isValidGpsCoordinate(lat: unknown, lng: unknown): boolean {
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    return false;
  }
  const numLat = typeof lat === 'number' ? lat : Number(lat);
  const numLng = typeof lng === 'number' ? lng : Number(lng);
  if (!Number.isFinite(numLat) || !Number.isFinite(numLng)) {
    return false;
  }
  if (numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) {
    return false;
  }
  if (numLat === 0 && numLng === 0) {
    return false;
  }
  return true;
}

export class CandidateGenerator {
  /**
   * Generates ranked eligible rider candidates for an order/dispatch context.
   * Strictly excludes riders missing valid, non-stale GPS coordinates (never substitutes store coordinates).
   */
  public async generateCandidates(
    context: DispatchCandidateContext
  ): Promise<RiderCandidate[]> {
    const pool = getPool();
    const maxStaleMs = DEFAULT_MAX_GPS_STALENESS_MS;

    // Query active available riders with valid non-null non-(0,0) DB coordinates
    const res = await pool.query(`
      SELECT id, rider_code, name, phone, vehicle_type, payload_capacity_kg,
             rating, tier, status, latitude, longitude, location_updated_at
      FROM riders
      WHERE status IN ('AVAILABLE', 'IDLE_AT_HUB')
        AND is_payout_held = FALSE
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND latitude BETWEEN -90 AND 90
        AND longitude BETWEEN -180 AND 180
        AND NOT (latitude = 0 AND longitude = 0)
    `);

    if (res.rows.length === 0) {
      return [];
    }

    const econConfig = await deliveryEconomicsService.getConfig();
    const candidates: RiderCandidate[] = [];
    const nowMs = Date.now();

    for (const row of res.rows) {
      if (context.excludeRiderIds && context.excludeRiderIds.includes(row.id)) {
        continue;
      }

      // Check live Redis telemetry first if present & fresher, else use DB coordinates + location_updated_at
      let riderLat = row.latitude !== null && row.latitude !== undefined ? Number(row.latitude) : NaN;
      let riderLng = row.longitude !== null && row.longitude !== undefined ? Number(row.longitude) : NaN;
      let gpsTimestampMs = row.location_updated_at ? new Date(row.location_updated_at).getTime() : NaN;

      try {
        const liveLoc = await liveLocationService.getRiderLocation(row.id);
        if (
          liveLoc &&
          isValidGpsCoordinate(liveLoc.latitude, liveLoc.longitude) &&
          Number.isFinite(liveLoc.timestamp) &&
          (!Number.isFinite(gpsTimestampMs) || liveLoc.timestamp >= gpsTimestampMs)
        ) {
          riderLat = liveLoc.latitude;
          riderLng = liveLoc.longitude;
          gpsTimestampMs = liveLoc.timestamp;
        }
      } catch {
        // Non-blocking Redis check; fall back to PostgreSQL row location_updated_at
      }

      if (!isValidGpsCoordinate(riderLat, riderLng)) {
        continue;
      }

      if (!Number.isFinite(gpsTimestampMs) || nowMs - gpsTimestampMs > maxStaleMs) {
        continue;
      }

      // Delegate routing calculation to RoutingService
      const routeResult = await routingService.calculateRoute(
        { latitude: riderLat, longitude: riderLng },
        context.storeLocation,
        row.vehicle_type === 'bicycle' ? 'two_wheeler' : 'two_wheeler'
      );

      const distMeters = routeResult.selectedRoute.distanceMeters;
      const distKm = routeResult.selectedRoute.distanceKm;
      const etaMinutes = routeResult.selectedRoute.durationMinutes;

      // Delegate payout calculation to DeliveryEconomicsService
      const unitEcon = deliveryEconomicsService.calculateUnitEconomics({
        cartTotal: context.itemsSubtotal,
        customerDeliveryFee: context.customerDeliveryFee,
        handlingFee: context.handlingFee,
        commissionAmount: +(context.itemsSubtotal * 0.15).toFixed(2), // 15% platform commission
        distanceKm: distKm,
        config: econConfig,
      });

      // Filter by vehicle payload capacity
      const requiredWeight = context.totalWeightKg || 5.0;
      if (parseFloat(row.payload_capacity_kg) < requiredWeight) {
        continue;
      }

      candidates.push({
        riderId: row.id,
        riderCode: row.rider_code,
        name: row.name,
        phone: row.phone,
        vehicleType: row.vehicle_type,
        payloadCapacityKg: parseFloat(row.payload_capacity_kg),
        rating: parseFloat(row.rating || '5.0'),
        tier: row.tier || 'Bronze',
        status: row.status,
        latitude: riderLat,
        longitude: riderLng,
        distanceToStoreMeters: distMeters,
        etaToStoreMinutes: etaMinutes,
        payoutAmountInr: unitEcon.riderPayout,
        isEconomicallyViable: unitEcon.isEconomicallyViable,
      });
    }

    return candidates;
  }
}

export const candidateGenerator = new CandidateGenerator();

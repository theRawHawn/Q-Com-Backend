import { getPool } from '../../database/connection.js';
import { routingService } from '../routing/routingService.js';
import { deliveryEconomicsService } from '../delivery/deliveryEconomicsService.js';
import { DispatchCandidateContext, RiderCandidate } from './dispatchTypes.js';

export class CandidateGenerator {
  /**
   * Generates ranked eligible rider candidates for an order/dispatch context
   */
  public async generateCandidates(
    context: DispatchCandidateContext
  ): Promise<RiderCandidate[]> {
    const pool = getPool();

    // Query active available riders from PostgreSQL
    const res = await pool.query(`
      SELECT id, rider_code, name, phone, vehicle_type, payload_capacity_kg, rating, tier, status, latitude, longitude
      FROM riders
      WHERE status IN ('AVAILABLE', 'IDLE_AT_HUB')
        AND is_payout_held = FALSE
    `);

    if (res.rows.length === 0) {
      return [];
    }

    const econConfig = await deliveryEconomicsService.getConfig();
    const candidates: RiderCandidate[] = [];

    for (const row of res.rows) {
      if (context.excludeRiderIds && context.excludeRiderIds.includes(row.id)) {
        continue;
      }

      const riderLat = row.latitude !== null ? parseFloat(row.latitude) : context.storeLocation.latitude;
      const riderLng = row.longitude !== null ? parseFloat(row.longitude) : context.storeLocation.longitude;

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

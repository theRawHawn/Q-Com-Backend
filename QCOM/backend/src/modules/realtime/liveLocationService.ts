import { getPool } from '../../database/connection.js';
import { cacheGet, cacheSet, cacheDel } from '../../database/redis.js';

export interface RiderLocationPing {
  riderId: string;
  latitude: number;
  longitude: number;
  heading?: number;
  speed?: number;
  timestamp: number;
}

export interface RiderLocationRecord extends RiderLocationPing {
  orderId?: string;
  tripId?: string;
  recordedAt: number;
}

/**
 * Calculates Great-Circle distance between two coordinates in kilometers using Haversine formula.
 */
function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export class LiveLocationService {
  private maxVelocityKmH = 120; // 120 km/h sanity ceiling for Indian urban delivery
  private ttlSeconds = 60; // 60s ephemeral TTL

  /**
   * Ingests high-frequency GPS ping for a delivery partner.
   * Enforces:
   * 1. Active delivery trip requirement
   * 2. Stale / out-of-order timestamp rejection
   * 3. Velocity sanity check (anti-spoofing)
   * 4. Zero PostgreSQL writes (stored strictly in ephemeral Redis with 60s TTL)
   */
  public async ingestRiderLocation(
    ping: RiderLocationPing,
    broadcaster?: (room: string, payload: any) => void
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    const { riderId, latitude, longitude, heading, speed, timestamp } = ping;

    // Validate numerical coordinates
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return { success: false, error: 'INVALID_COORDINATES' };
    }

    const currentPingTime = timestamp || Date.now();

    // 1. Verify that rider currently has an ACTIVE delivery trip in PostgreSQL
    const pool = getPool();
    let tripRes: any;
    try {
      tripRes = await pool.query(
        `SELECT id, order_id, status 
         FROM delivery_trips 
         WHERE rider_id = $1 AND status IN ('ACCEPTED', 'ARRIVED_AT_PICKUP', 'PICKED_UP', 'ARRIVED_AT_DROP')
         LIMIT 1`,
        [riderId]
      );
    } catch (err: any) {
      return { success: false, error: 'DATABASE_ERROR: ' + err.message };
    }

    if (tripRes.rows.length === 0) {
      return {
        success: false,
        error: 'NO_ACTIVE_DELIVERY: Rider has no active delivery trip in progress.',
      };
    }

    const activeTrip = tripRes.rows[0];
    const orderId = activeTrip.order_id;
    const tripId = activeTrip.id;

    // 2. Fetch previous ping from ephemeral Redis cache
    const cacheKey = `rider:loc:${riderId}`;
    const prevData = await cacheGet(cacheKey);

    if (prevData) {
      try {
        const prevPing: RiderLocationRecord = JSON.parse(prevData);

        // Stale timestamp rejection: reject if incoming timestamp is older or equal
        if (currentPingTime <= prevPing.timestamp) {
          return {
            success: false,
            error: 'STALE_GPS_TIMESTAMP: Incoming GPS timestamp is older than or equal to last recorded ping.',
          };
        }

        // Velocity sanity check
        const deltaSeconds = (currentPingTime - prevPing.timestamp) / 1000;
        if (deltaSeconds >= 1) {
          const distKm = haversineDistanceKm(
            prevPing.latitude,
            prevPing.longitude,
            latitude,
            longitude
          );
          const computedVelocity = (distKm / deltaSeconds) * 3600;

          if (computedVelocity > this.maxVelocityKmH) {
            return {
              success: false,
              error: `GPS_VELOCITY_CHECK_FAILED: Impossible speed detected (${Math.round(computedVelocity)} km/h > ${this.maxVelocityKmH} km/h). Potential location spoofing.`,
            };
          }
        }
      } catch {
        // Ignore json parse error and proceed
      }
    }

    // 3. Save latest coordinates to Redis with 60-second TTL
    const record: RiderLocationRecord = {
      riderId,
      latitude,
      longitude,
      heading,
      speed,
      timestamp: currentPingTime,
      orderId,
      tripId,
      recordedAt: Date.now(),
    };

    await cacheSet(cacheKey, JSON.stringify(record), this.ttlSeconds);

    // 4. Broadcast live coordinates to active order room
    if (broadcaster) {
      broadcaster(`order:${orderId}`, {
        type: 'event',
        channel: `order:${orderId}`,
        eventType: 'rider.location_updated',
        payload: {
          riderId,
          orderId,
          latitude,
          longitude,
          heading,
          speed,
          timestamp: currentPingTime,
        },
        timestamp: new Date().toISOString(),
      });
    }

    return { success: true, orderId };
  }

  /**
   * Retrieves latest ephemeral location for a rider from Redis.
   */
  public async getRiderLocation(riderId: string): Promise<RiderLocationRecord | null> {
    const raw = await cacheGet(`rider:loc:${riderId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Removes rider location from Redis on trip completion or rider going offline.
   */
  public async clearRiderLocation(riderId: string): Promise<void> {
    await cacheDel(`rider:loc:${riderId}`);
  }
}

export const liveLocationService = new LiveLocationService();

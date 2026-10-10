import pg from 'pg';
import crypto from 'crypto';
import { getPool, transaction } from '../../database/connection.js';
import { candidateGenerator } from './candidateGenerator.js';
import { defaultScoringStrategy } from './dispatchScoringStrategy.js';
import { dispatchEventPublisher } from './dispatchEvents.js';
import { outboxService } from '../outbox/outboxService.js';
import { DispatchAssignmentRecord, DispatchCandidateContext, DispatchOfferRecord, RiderCandidate } from './dispatchTypes.js';

export class DispatchService {
  /**
   * Atomic Dispatch Assignment Creation & Offer Broadcast
   */
  public async assignOrder(params: {
    orderId: string;
    offerExpirySeconds?: number;
    clientOverride?: pg.PoolClient;
    pendingEvents?: { eventType: string; payload: any }[];
  }): Promise<{
    assignment: DispatchAssignmentRecord;
    offer: DispatchOfferRecord;
    selectedRider: RiderCandidate;
    candidateCount: number;
  }> {
    const pool = getPool();
    const expirySec = params.offerExpirySeconds || 60;
    const localPendingEvents: { eventType: string; payload: any }[] = [];

    // 1. Retrieve order and merchant details from PostgreSQL
    const orderRes = await pool.query(`
      SELECT o.id, o.merchant_id, o.items_subtotal, o.delivery_fee, o.handling_fee, o.jobsite_address, o.status,
             m.latitude as merchant_lat, m.longitude as merchant_lng
      FROM orders o
      JOIN merchants m ON o.merchant_id = m.id
      WHERE o.id = $1
    `, [params.orderId]);

    if (orderRes.rows.length === 0) {
      throw new Error(`ORDER_NOT_FOUND: Order '${params.orderId}' does not exist.`);
    }

    const orderRow = orderRes.rows[0];
    if (orderRow.status === 'cancelled' || orderRow.status === 'delivered') {
      throw new Error(`ORDER_NOT_DISPATCHABLE: Order '${params.orderId}' is in '${orderRow.status}' state.`);
    }

    const jobsite = typeof orderRow.jobsite_address === 'string'
      ? JSON.parse(orderRow.jobsite_address)
      : orderRow.jobsite_address;

    const storeLocation = {
      latitude: parseFloat(orderRow.merchant_lat || '12.9716'),
      longitude: parseFloat(orderRow.merchant_lng || '77.5946'),
    };
    const customerLocation = {
      latitude: parseFloat(jobsite.latitude || '12.9716'),
      longitude: parseFloat(jobsite.longitude || '77.5946'),
    };

    const context: DispatchCandidateContext = {
      orderId: orderRow.id,
      merchantId: orderRow.merchant_id,
      storeLocation,
      customerLocation,
      itemsSubtotal: parseFloat(orderRow.items_subtotal),
      customerDeliveryFee: parseFloat(orderRow.delivery_fee),
      handlingFee: parseFloat(orderRow.handling_fee),
    };

    // 2. Candidate Generation & Scoring
    const candidates = await candidateGenerator.generateCandidates(context);
    if (candidates.length === 0) {
      throw new Error('NO_ELIGIBLE_RIDERS: No available delivery partners found in service radius.');
    }

    const scoredCandidates = candidates.map(c => defaultScoringStrategy.scoreCandidate(c, context));
    scoredCandidates.sort((a, b) => b.score - a.score);

    const topCandidate = scoredCandidates[0].candidate;

    // 3. Persist Assignment & Offer in PostgreSQL with Row Locking
    const execute = async (client: pg.PoolClient) => {
      // Check if order already has an active assignment
      const activeAssignCheck = await client.query(`
        SELECT id, status FROM dispatch_assignments
        WHERE order_id = $1 AND status IN ('CREATED', 'OFFERED', 'ACCEPTED')
        FOR UPDATE
      `, [params.orderId]);

      if (activeAssignCheck.rows.length > 0) {
        throw new Error(`ORDER_ALREADY_ASSIGNED: Order '${params.orderId}' already has active assignment '${activeAssignCheck.rows[0].id}'.`);
      }

      // Lock rider row
      const riderLock = await client.query(`
        SELECT id, status FROM riders
        WHERE id = $1
        FOR UPDATE
      `, [topCandidate.riderId]);

      if (riderLock.rows.length === 0) {
        throw new Error(`RIDER_NOT_FOUND: Rider '${topCandidate.riderId}' not found.`);
      }

      const currentRiderStatus = riderLock.rows[0].status;
      if (!['AVAILABLE', 'IDLE_AT_HUB'].includes(currentRiderStatus)) {
        throw new Error(`RIDER_UNAVAILABLE: Rider '${topCandidate.riderId}' status changed to '${currentRiderStatus}'.`);
      }

      const assignmentId = crypto.randomUUID();
      const offerId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + expirySec * 1000);

      // Insert assignment
      const insAssign = await client.query(`
        INSERT INTO dispatch_assignments (id, order_id, rider_id, status, scoring_snapshot)
        VALUES ($1, $2, $3, 'OFFERED', $4)
        RETURNING id, order_id, delivery_trip_id, rider_id, status, scoring_snapshot, created_at, updated_at
      `, [
        assignmentId,
        params.orderId,
        topCandidate.riderId,
        JSON.stringify(scoredCandidates[0]),
      ]);

      // Insert offer
      const insOffer = await client.query(`
        INSERT INTO dispatch_offers (id, assignment_id, rider_id, order_id, status, expires_at)
        VALUES ($1, $2, $3, $4, 'OFFERED', $5)
        RETURNING id, assignment_id, rider_id, order_id, status, expires_at, created_at, updated_at
      `, [
        offerId,
        assignmentId,
        topCandidate.riderId,
        params.orderId,
        expiresAt,
      ]);

      // Update rider status to OFFERED
      await client.query(`
        UPDATE riders SET status = 'OFFERED', updated_at = NOW() WHERE id = $1
      `, [topCandidate.riderId]);

      const assignRow = insAssign.rows[0];
      const offerRow = insOffer.rows[0];

      // Stage domain events for post-commit publication
      localPendingEvents.push({ eventType: 'OrderReadyForDispatch', payload: { orderId: params.orderId, merchantId: orderRow.merchant_id } });
      localPendingEvents.push({ eventType: 'RiderAssignmentCreated', payload: { assignmentId, orderId: params.orderId, riderId: topCandidate.riderId } });
      localPendingEvents.push({ eventType: 'RiderOfferCreated', payload: { offerId, assignmentId, riderId: topCandidate.riderId, expiresAt: expiresAt.toISOString() } });

      // Stage transactional outbox event
      await outboxService.stageEvent(client, {
        eventType: 'DISPATCH_OFFERED',
        aggregateType: 'DISPATCH_OFFER',
        aggregateId: offerId,
        payload: {
          offerId,
          assignmentId,
          riderId: topCandidate.riderId,
          orderId: params.orderId,
          expiresAt: expiresAt.toISOString(),
        },
      });

      return {
        assignment: {
          id: assignRow.id,
          orderId: assignRow.order_id,
          deliveryTripId: assignRow.delivery_trip_id || undefined,
          riderId: assignRow.rider_id,
          status: assignRow.status,
          scoringSnapshot: assignRow.scoring_snapshot,
          createdAt: assignRow.created_at.toISOString(),
          updatedAt: assignRow.updated_at.toISOString(),
        },
        offer: {
          id: offerRow.id,
          assignmentId: offerRow.assignment_id,
          riderId: offerRow.rider_id,
          orderId: offerRow.order_id,
          status: offerRow.status,
          expiresAt: offerRow.expires_at.toISOString(),
          createdAt: offerRow.created_at.toISOString(),
          updatedAt: offerRow.updated_at.toISOString(),
        },
        selectedRider: topCandidate,
        candidateCount: candidates.length,
      };
    };

    if (params.clientOverride) {
      const result = await execute(params.clientOverride);
      if (params.pendingEvents) {
        params.pendingEvents.push(...localPendingEvents);
      }
      return result;
    }

    const result = await transaction(execute);
    // Emit domain events strictly AFTER database commit
    for (const evt of localPendingEvents) {
      dispatchEventPublisher.emit(evt.eventType, evt.payload);
    }
    return result;
  }

  /**
   * Atomic Offer Acceptance by Rider
   */
  public async acceptOffer(offerId: string, riderId: string): Promise<{
    assignment: DispatchAssignmentRecord;
    offer: DispatchOfferRecord;
    tripId: string;
  }> {
    const localPendingEvents: { eventType: string; payload: any }[] = [];

    const result = await transaction(async (client) => {
      // 1. Lock offer row
      const offerRes = await client.query(`
        SELECT id, assignment_id, rider_id, order_id, status, expires_at
        FROM dispatch_offers
        WHERE id = $1
        FOR UPDATE
      `, [offerId]);

      if (offerRes.rows.length === 0) {
        throw new Error(`OFFER_NOT_FOUND: Offer '${offerId}' does not exist.`);
      }

      const offerRow = offerRes.rows[0];

      // Verify rider ownership of the offer
      if (offerRow.rider_id !== riderId) {
        throw new Error(`UNAUTHORIZED_RIDER: Offer '${offerId}' was issued to a different rider.`);
      }

      // Idempotent return if already accepted
      if (offerRow.status === 'ACCEPTED') {
        const assignRes = await client.query(`SELECT * FROM dispatch_assignments WHERE id = $1`, [offerRow.assignment_id]);
        const tripRes = await client.query(`SELECT id FROM delivery_trips WHERE order_id = $1`, [offerRow.order_id]);
        const a = assignRes.rows[0];
        return {
          assignment: {
            id: a.id,
            orderId: a.order_id,
            deliveryTripId: a.delivery_trip_id || undefined,
            riderId: a.rider_id,
            status: a.status,
            scoringSnapshot: a.scoring_snapshot,
            createdAt: a.created_at.toISOString(),
            updatedAt: a.updated_at.toISOString(),
          },
          offer: {
            id: offerRow.id,
            assignmentId: offerRow.assignment_id,
            riderId: offerRow.rider_id,
            orderId: offerRow.order_id,
            status: offerRow.status,
            expiresAt: offerRow.expires_at.toISOString(),
            createdAt: offerRow.created_at.toISOString(),
            updatedAt: offerRow.updated_at.toISOString(),
          },
          tripId: tripRes.rows[0]?.id || '',
        };
      }

      // Check if offer has expired
      if (offerRow.status === 'EXPIRED' || new Date() > new Date(offerRow.expires_at)) {
        await client.query(`UPDATE dispatch_offers SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`, [offerId]);
        await client.query(`UPDATE dispatch_assignments SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1 AND status = 'OFFERED'`, [offerRow.assignment_id]);
        await client.query(`UPDATE riders SET status = 'AVAILABLE', updated_at = NOW() WHERE id = $1 AND status = 'OFFERED'`, [riderId]);
        throw new Error(`OFFER_EXPIRED: Offer '${offerId}' has expired.`);
      }

      // Check illegal offer states
      if (['REJECTED', 'CANCELLED'].includes(offerRow.status)) {
        throw new Error(`OFFER_INVALID_STATE: Cannot accept offer in '${offerRow.status}' status.`);
      }

      // 2. Lock parent assignment row
      const assignRes = await client.query(`
        SELECT id, order_id, rider_id, status FROM dispatch_assignments WHERE id = $1 FOR UPDATE
      `, [offerRow.assignment_id]);

      if (assignRes.rows.length === 0) {
        throw new Error(`ASSIGNMENT_NOT_FOUND: Parent assignment '${offerRow.assignment_id}' does not exist.`);
      }

      const assignRow = assignRes.rows[0];

      // F-02: Verify parent assignment status is OFFERED
      if (assignRow.status === 'CANCELLED') {
        throw new Error(`ASSIGNMENT_CANCELLED: Cannot accept offer because parent assignment '${assignRow.id}' was cancelled.`);
      }

      if (assignRow.status !== 'OFFERED') {
        throw new Error(`ASSIGNMENT_INVALID_STATE: Cannot accept offer when parent assignment is in '${assignRow.status}' status.`);
      }

      // Verify the offer belongs to the current assignment and order
      if (assignRow.id !== offerRow.assignment_id || assignRow.order_id !== offerRow.order_id) {
        throw new Error(`ASSIGNMENT_MISMATCH: Offer '${offerId}' does not belong to assignment '${assignRow.id}'.`);
      }

      // Lock rider row
      const riderLock = await client.query(`SELECT id, status FROM riders WHERE id = $1 FOR UPDATE`, [riderId]);
      if (riderLock.rows.length === 0) {
        throw new Error(`RIDER_NOT_FOUND: Rider '${riderId}' not found.`);
      }

      // 3. Atomically update offer & assignment status to ACCEPTED
      await client.query(`UPDATE dispatch_offers SET status = 'ACCEPTED', updated_at = NOW() WHERE id = $1`, [offerId]);
      await client.query(`UPDATE dispatch_assignments SET status = 'ACCEPTED', updated_at = NOW() WHERE id = $1`, [offerRow.assignment_id]);

      // 4. Update rider status to ASSIGNED
      await client.query(`UPDATE riders SET status = 'ASSIGNED', updated_at = NOW() WHERE id = $1`, [riderId]);

      // 5. Upsert delivery_trips record
      let tripId = crypto.randomUUID();
      const existingTrip = await client.query(`SELECT id FROM delivery_trips WHERE order_id = $1`, [offerRow.order_id]);
      if (existingTrip.rows.length > 0) {
        tripId = existingTrip.rows[0].id;
        await client.query(`
          UPDATE delivery_trips
          SET rider_id = $1, status = 'ACCEPTED', accepted_at = NOW()
          WHERE id = $2
        `, [riderId, tripId]);
      } else {
        await client.query(`
          INSERT INTO delivery_trips (id, order_id, rider_id, status, accepted_at, base_fare, distance_fare, surge_fare, total_rider_payout)
          VALUES ($1, $2, $3, 'ACCEPTED', NOW(), 35.00, 15.00, 0.00, 50.00)
        `, [tripId, offerRow.order_id, riderId]);
      }

      // Link trip ID back to assignment
      await client.query(`
        UPDATE dispatch_assignments SET delivery_trip_id = $1 WHERE id = $2
      `, [tripId, offerRow.assignment_id]);

      // Update order status to picking
      await client.query(`
        UPDATE orders SET status = 'picking' WHERE id = $1 AND status = 'placed'
      `, [offerRow.order_id]);

      // Stage domain event for post-commit publication
      localPendingEvents.push({
        eventType: 'RiderOfferAccepted',
        payload: { offerId, assignmentId: offerRow.assignment_id, riderId, orderId: offerRow.order_id, tripId },
      });

      // Stage transactional outbox event
      await outboxService.stageEvent(client, {
        eventType: 'DISPATCH_ACCEPTED',
        aggregateType: 'DISPATCH_OFFER',
        aggregateId: offerId,
        payload: {
          offerId,
          assignmentId: offerRow.assignment_id,
          riderId,
          orderId: offerRow.order_id,
          tripId,
        },
      });

      const updatedAssign = await client.query(`SELECT * FROM dispatch_assignments WHERE id = $1`, [offerRow.assignment_id]);
      const updatedOffer = await client.query(`SELECT * FROM dispatch_offers WHERE id = $1`, [offerId]);

      const a = updatedAssign.rows[0];
      const o = updatedOffer.rows[0];

      return {
        assignment: {
          id: a.id,
          orderId: a.order_id,
          deliveryTripId: a.delivery_trip_id,
          riderId: a.rider_id,
          status: a.status,
          scoringSnapshot: a.scoring_snapshot,
          createdAt: a.created_at.toISOString(),
          updatedAt: a.updated_at.toISOString(),
        },
        offer: {
          id: o.id,
          assignmentId: o.assignment_id,
          riderId: o.rider_id,
          orderId: o.order_id,
          status: o.status,
          expiresAt: o.expires_at.toISOString(),
          createdAt: o.created_at.toISOString(),
          updatedAt: o.updated_at.toISOString(),
        },
        tripId,
      };
    });

    // F-04: Emit domain events strictly AFTER database commit
    for (const evt of localPendingEvents) {
      dispatchEventPublisher.emit(evt.eventType, evt.payload);
    }

    return result;
  }

  /**
   * Atomic Offer Rejection by Rider
   */
  public async rejectOffer(offerId: string, riderId: string, reason?: string): Promise<{
    offer: DispatchOfferRecord;
    assignment: DispatchAssignmentRecord;
  }> {
    const localPendingEvents: { eventType: string; payload: any }[] = [];

    const result = await transaction(async (client) => {
      const offerRes = await client.query(`
        SELECT id, assignment_id, rider_id, order_id, status FROM dispatch_offers WHERE id = $1 FOR UPDATE
      `, [offerId]);

      if (offerRes.rows.length === 0) {
        throw new Error(`OFFER_NOT_FOUND: Offer '${offerId}' does not exist.`);
      }

      const offerRow = offerRes.rows[0];

      if (offerRow.rider_id !== riderId) {
        throw new Error(`UNAUTHORIZED_RIDER: Offer '${offerId}' belongs to a different rider.`);
      }

      if (offerRow.status === 'ACCEPTED') {
        throw new Error(`CANNOT_REJECT_ACCEPTED_OFFER: Offer '${offerId}' has already been accepted.`);
      }

      if (offerRow.status === 'CANCELLED') {
        throw new Error(`OFFER_INVALID_STATE: Cannot reject cancelled offer '${offerId}'.`);
      }

      // Update offer to REJECTED
      await client.query(`
        UPDATE dispatch_offers SET status = 'REJECTED', rejection_reason = $2, updated_at = NOW() WHERE id = $1
      `, [offerId, reason || 'Rider declined offer']);

      // Update assignment to REJECTED if it is currently OFFERED
      await client.query(`
        UPDATE dispatch_assignments SET status = 'REJECTED', updated_at = NOW() WHERE id = $1 AND status = 'OFFERED'
      `, [offerRow.assignment_id]);

      // Release rider back to AVAILABLE
      await client.query(`
        UPDATE riders SET status = 'AVAILABLE', updated_at = NOW() WHERE id = $1 AND status = 'OFFERED'
      `, [riderId]);

      localPendingEvents.push({
        eventType: 'RiderOfferRejected',
        payload: { offerId, assignmentId: offerRow.assignment_id, riderId, reason },
      });

      // Stage transactional outbox event
      await outboxService.stageEvent(client, {
        eventType: 'DISPATCH_REJECTED',
        aggregateType: 'DISPATCH_OFFER',
        aggregateId: offerId,
        payload: { offerId, assignmentId: offerRow.assignment_id, riderId, reason },
      });

      const updatedAssign = await client.query(`SELECT * FROM dispatch_assignments WHERE id = $1`, [offerRow.assignment_id]);
      const updatedOffer = await client.query(`SELECT * FROM dispatch_offers WHERE id = $1`, [offerId]);

      const a = updatedAssign.rows[0];
      const o = updatedOffer.rows[0];

      return {
        assignment: {
          id: a.id,
          orderId: a.order_id,
          deliveryTripId: a.delivery_trip_id,
          riderId: a.rider_id,
          status: a.status,
          scoringSnapshot: a.scoring_snapshot,
          createdAt: a.created_at.toISOString(),
          updatedAt: a.updated_at.toISOString(),
        },
        offer: {
          id: o.id,
          assignmentId: o.assignment_id,
          riderId: o.rider_id,
          orderId: o.order_id,
          status: o.status,
          rejectionReason: o.rejection_reason,
          expiresAt: o.expires_at.toISOString(),
          createdAt: o.created_at.toISOString(),
          updatedAt: o.updated_at.toISOString(),
        },
      };
    });

    // F-04: Emit domain events strictly AFTER database commit
    for (const evt of localPendingEvents) {
      dispatchEventPublisher.emit(evt.eventType, evt.payload);
    }

    return result;
  }

  /**
   * Atomic Expiration of Stale Offer
   */
  public async expireOffer(offerId: string): Promise<void> {
    const localPendingEvents: { eventType: string; payload: any }[] = [];

    await transaction(async (client) => {
      const offerRes = await client.query(`
        SELECT id, assignment_id, rider_id, status FROM dispatch_offers WHERE id = $1 FOR UPDATE
      `, [offerId]);

      if (offerRes.rows.length === 0) return;

      const o = offerRes.rows[0];
      if (o.status === 'OFFERED') {
        await client.query(`UPDATE dispatch_offers SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`, [offerId]);
        await client.query(`UPDATE dispatch_assignments SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1 AND status = 'OFFERED'`, [o.assignment_id]);
        await client.query(`UPDATE riders SET status = 'AVAILABLE', updated_at = NOW() WHERE id = $1 AND status = 'OFFERED'`, [o.rider_id]);

        localPendingEvents.push({
          eventType: 'RiderOfferExpired',
          payload: { offerId, assignmentId: o.assignment_id, riderId: o.rider_id },
        });

        // Stage transactional outbox event
        await outboxService.stageEvent(client, {
          eventType: 'DISPATCH_EXPIRED',
          aggregateType: 'DISPATCH_OFFER',
          aggregateId: offerId,
          payload: { offerId, assignmentId: o.assignment_id, riderId: o.rider_id },
        });
      }
    });

    // F-04: Emit domain events strictly AFTER database commit
    for (const evt of localPendingEvents) {
      dispatchEventPublisher.emit(evt.eventType, evt.payload);
    }
  }

  /**
   * Atomic Rematching for Order
   * F-03: Restricts rematching to OFFERED, REJECTED, or EXPIRED assignments.
   * Synchronizes active offers to CANCELLED and executes within a single transaction.
   */
  public async rematchOrder(assignmentId: string): Promise<{
    oldAssignmentId: string;
    newAssignment: DispatchAssignmentRecord;
    newOffer: DispatchOfferRecord;
  }> {
    const localPendingEvents: { eventType: string; payload: any }[] = [];

    const result = await transaction(async (client) => {
      // 1. Lock assignment row
      const assignRes = await client.query(
        `SELECT id, order_id, rider_id, status FROM dispatch_assignments WHERE id = $1 FOR UPDATE`,
        [assignmentId]
      );

      if (assignRes.rows.length === 0) {
        throw new Error(`ASSIGNMENT_NOT_FOUND: Assignment '${assignmentId}' does not exist.`);
      }

      const assignRow = assignRes.rows[0];
      const { order_id: orderId, rider_id: prevRiderId, status: currentStatus } = assignRow;

      // F-03: Enforce valid state for rematching (must be OFFERED, REJECTED, or EXPIRED)
      if (!['OFFERED', 'REJECTED', 'EXPIRED'].includes(currentStatus)) {
        throw new Error(`INVALID_REMATCH_STATE: Cannot rematch assignment in '${currentStatus}' status.`);
      }

      // 2. Cancel old assignment
      await client.query(
        `UPDATE dispatch_assignments SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1`,
        [assignmentId]
      );

      // F-03: Synchronize offers - cancel any pending offers for this assignment
      await client.query(
        `UPDATE dispatch_offers SET status = 'CANCELLED', updated_at = NOW() WHERE assignment_id = $1 AND status = 'OFFERED'`,
        [assignmentId]
      );

      // 3. Release previous rider back to AVAILABLE if they were OFFERED
      await client.query(
        `UPDATE riders SET status = 'AVAILABLE', updated_at = NOW() WHERE id = $1 AND status = 'OFFERED'`,
        [prevRiderId]
      );

      // Stage rematch event
      localPendingEvents.push({
        eventType: 'DispatchRematchRequested',
        payload: { assignmentId, orderId, previousRiderId: prevRiderId },
      });

      // Stage transactional outbox event
      await outboxService.stageEvent(client, {
        eventType: 'DISPATCH_ASSIGNED',
        aggregateType: 'DISPATCH_ASSIGNMENT',
        aggregateId: assignmentId,
        payload: { assignmentId, orderId, previousRiderId: prevRiderId },
      });

      // 4. Re-run dispatch assignment within the SAME transaction
      const assignResult = await this.assignOrder({
        orderId,
        clientOverride: client,
        pendingEvents: localPendingEvents,
      });

      return {
        oldAssignmentId: assignmentId,
        newAssignment: assignResult.assignment,
        newOffer: assignResult.offer,
      };
    });

    // F-04: Emit domain events strictly AFTER database commit
    for (const evt of localPendingEvents) {
      dispatchEventPublisher.emit(evt.eventType, evt.payload);
    }

    return result;
  }

  /**
   * Query assignment by Order ID
   */
  public async getAssignmentByOrderId(orderId: string): Promise<DispatchAssignmentRecord | null> {
    const pool = getPool();
    const res = await pool.query(`
      SELECT * FROM dispatch_assignments
      WHERE order_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [orderId]);

    if (res.rows.length === 0) return null;
    const a = res.rows[0];
    return {
      id: a.id,
      orderId: a.order_id,
      deliveryTripId: a.delivery_trip_id || undefined,
      riderId: a.rider_id,
      status: a.status,
      scoringSnapshot: a.scoring_snapshot,
      createdAt: a.created_at.toISOString(),
      updatedAt: a.updated_at.toISOString(),
    };
  }

  /**
   * Query assignment by Assignment ID
   */
  public async getAssignmentById(assignmentId: string): Promise<DispatchAssignmentRecord | null> {
    const pool = getPool();
    const res = await pool.query(`
      SELECT * FROM dispatch_assignments
      WHERE id = $1
      LIMIT 1
    `, [assignmentId]);

    if (res.rows.length === 0) return null;
    const a = res.rows[0];
    return {
      id: a.id,
      orderId: a.order_id,
      deliveryTripId: a.delivery_trip_id || undefined,
      riderId: a.rider_id,
      status: a.status,
      scoringSnapshot: a.scoring_snapshot,
      createdAt: a.created_at.toISOString(),
      updatedAt: a.updated_at.toISOString(),
    };
  }

  /**
   * Concurrency-safe cancellation of active dispatch assignments, offers and trips
   */
  public async cancelOrderDispatch(orderId: string, clientOverride?: pg.PoolClient): Promise<void> {
    const execute = async (client: pg.PoolClient) => {
      // 1. Lock and fetch active assignments
      const assignRes = await client.query(`
        SELECT id, rider_id, status FROM dispatch_assignments
        WHERE order_id = $1 AND status IN ('CREATED', 'OFFERED', 'ACCEPTED')
        FOR UPDATE
      `, [orderId]);

      for (const a of assignRes.rows) {
        await client.query(`
          UPDATE dispatch_assignments
          SET status = 'CANCELLED', updated_at = NOW()
          WHERE id = $1
        `, [a.id]);

        await client.query(`
          UPDATE dispatch_offers
          SET status = 'CANCELLED'
          WHERE assignment_id = $1 AND status IN ('OFFERED', 'PENDING', 'ACCEPTED')
        `, [a.id]);

        if (a.rider_id) {
          await client.query(`
            UPDATE riders
            SET status = 'IDLE_AT_HUB', updated_at = NOW()
            WHERE id = $1 AND status IN ('PICKING_UP', 'IN_TRANSIT', 'ARRIVED_AT_DROP')
          `, [a.rider_id]);
        }
      }

      // 2. Cancel active delivery trips (not delivered)
      await client.query(`
        UPDATE delivery_trips
        SET status = 'CANCELLED'
        WHERE order_id = $1 AND status NOT IN ('DELIVERED', 'CANCELLED')
      `, [orderId]);
    };

    if (clientOverride) {
      return execute(clientOverride);
    }
    return transaction(execute);
  }

  /**
   * Creates a reverse pickup trip for return logistics
   */
  public async createReversePickupTrip(params: {
    returnId: string;
    orderId: string;
    merchantId: string;
    clientOverride?: pg.PoolClient;
  }): Promise<string> {
    const execute = async (client: pg.PoolClient) => {
      const tripRes = await client.query(`SELECT id FROM delivery_trips WHERE order_id = $1 LIMIT 1`, [params.orderId]);
      let tripId: string;
      if (tripRes.rows.length > 0) {
        tripId = tripRes.rows[0].id;
      } else {
        tripId = crypto.randomUUID();
        await client.query(`
          INSERT INTO delivery_trips (id, order_id, status, base_fare, total_rider_payout)
          VALUES ($1, $2, 'ACCEPTED', 35.00, 35.00)
        `, [tripId, params.orderId]);
      }

      await client.query(`
        UPDATE order_returns
        SET pickup_trip_id = $1, status = 'PICKUP_ASSIGNED', approved_at = COALESCE(approved_at, NOW())
        WHERE id = $2
      `, [tripId, params.returnId]);

      return tripId;
    };

    if (params.clientOverride) {
      return execute(params.clientOverride);
    }
    return transaction(execute);
  }
}

export const dispatchService = new DispatchService();

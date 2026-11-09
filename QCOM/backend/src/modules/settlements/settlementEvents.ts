import crypto from 'crypto';

export interface SettlementDomainEvent {
  eventId: string;
  eventType:
    | 'OrderSettlementAllocated'
    | 'SellerSettlementEligible'
    | 'SellerPayoutInitiated'
    | 'SellerPayoutCompleted'
    | 'SellerPayoutFailed'
    | 'RiderEarningFrozen'
    | 'RiderPayoutInitiated'
    | 'RiderPayoutCompleted'
    | 'RiderPayoutFailed'
    | 'RiderCodRemitted';
  timestamp: string;
  payload: any;
}

export class SettlementEventPublisher {
  private eventsLog: SettlementDomainEvent[] = [];

  public createEvent(eventType: SettlementDomainEvent['eventType'], payload: any): SettlementDomainEvent {
    return {
      eventId: crypto.randomUUID(),
      eventType,
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  public publish(event: SettlementDomainEvent): void {
    this.eventsLog.push(event);
    console.log(`[SettlementDomainEvent] [${event.eventType}] ID: ${event.eventId}`, JSON.stringify(event.payload));
  }

  public publishAll(events: SettlementDomainEvent[]): void {
    for (const event of events) {
      try {
        this.publish(event);
      } catch (err: any) {
        console.error(`[SettlementDomainEvent Error] Failed to publish event ${event.eventId}:`, err.message);
      }
    }
  }

  public emit(eventType: SettlementDomainEvent['eventType'], payload: any): SettlementDomainEvent {
    const event = this.createEvent(eventType, payload);
    this.publish(event);
    return event;
  }

  public getLoggedEvents(): SettlementDomainEvent[] {
    return [...this.eventsLog];
  }

  public clearEventsLog(): void {
    this.eventsLog = [];
  }
}

export const settlementEventPublisher = new SettlementEventPublisher();

import crypto from 'crypto';

export interface PaymentDomainEvent {
  eventId: string;
  eventType:
    | 'PaymentCreated'
    | 'PaymentAuthorized'
    | 'PaymentCaptured'
    | 'PaymentFailed'
    | 'PaymentCancelled'
    | 'PaymentRefunded';
  timestamp: string;
  payload: any;
}

export class PaymentEventPublisher {
  private eventsLog: PaymentDomainEvent[] = [];

  public createEvent(eventType: PaymentDomainEvent['eventType'], payload: any): PaymentDomainEvent {
    return {
      eventId: crypto.randomUUID(),
      eventType,
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  public publish(event: PaymentDomainEvent): void {
    this.eventsLog.push(event);
    console.log(`[PaymentDomainEvent] [${event.eventType}] ID: ${event.eventId}`, JSON.stringify(event.payload));
  }

  public publishAll(events: PaymentDomainEvent[]): void {
    for (const event of events) {
      try {
        this.publish(event);
      } catch (err: any) {
        console.error(`[PaymentDomainEvent Error] Failed to publish event ${event.eventId}:`, err.message);
      }
    }
  }

  public emit(eventType: PaymentDomainEvent['eventType'], payload: any): PaymentDomainEvent {
    const event = this.createEvent(eventType, payload);
    this.publish(event);
    return event;
  }

  public getLoggedEvents(): PaymentDomainEvent[] {
    return [...this.eventsLog];
  }

  public clearEventsLog(): void {
    this.eventsLog = [];
  }
}

export const paymentEventPublisher = new PaymentEventPublisher();

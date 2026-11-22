import crypto from 'crypto';
import { redactPaymentLogPayload } from './paymentLogger.js';

export interface PaymentDomainEvent {
  eventId: string;
  eventType:
    | 'PaymentCreated'
    | 'PaymentInitiated'
    | 'PaymentAuthorized'
    | 'PaymentCaptured'
    | 'PaymentFailed'
    | 'PaymentCancelled'
    | 'PaymentExpired'
    | 'PaymentUnknown'
    | 'PaymentRequiresReview'
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
      payload: redactPaymentLogPayload(payload),
    };
  }

  public publish(event: PaymentDomainEvent): void {
    const redactedEvent: PaymentDomainEvent = {
      ...event,
      payload: redactPaymentLogPayload(event.payload),
    };
    this.eventsLog.push(redactedEvent);
    console.log(
      `[PaymentDomainEvent] [${redactedEvent.eventType}] ID: ${redactedEvent.eventId}`,
      JSON.stringify(redactedEvent.payload)
    );
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

import crypto from 'crypto';
import { DomainEvent } from './dispatchTypes.js';

export class DispatchEventPublisher {
  private eventsLog: DomainEvent[] = [];

  public createEvent(eventType: string, payload: any): DomainEvent {
    return {
      eventId: crypto.randomUUID(),
      eventType,
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  public publish(event: DomainEvent): void {
    this.eventsLog.push(event);
    console.log(`[DomainEvent] [${event.eventType}] ID: ${event.eventId}`, JSON.stringify(event.payload));
  }

  public publishAll(events: DomainEvent[]): void {
    for (const event of events) {
      try {
        this.publish(event);
      } catch (err: any) {
        console.error(`[DomainEvent Error] Failed to publish event ${event.eventId}:`, err.message);
      }
    }
  }

  public emit(eventType: string, payload: any): DomainEvent {
    const event = this.createEvent(eventType, payload);
    this.publish(event);
    return event;
  }

  public getLoggedEvents(): DomainEvent[] {
    return [...this.eventsLog];
  }

  public clearEventsLog(): void {
    this.eventsLog = [];
  }
}

export const dispatchEventPublisher = new DispatchEventPublisher();

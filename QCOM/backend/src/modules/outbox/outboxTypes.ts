export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED' | 'DEAD_LETTER';

export interface OutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: any;
  createdAt: string;
  publishedAt?: string;
  attemptCount: number;
  nextAttemptAt: string;
  leaseToken?: string;
  lastError?: string;
  status: OutboxStatus;
}

export interface StageEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: any;
}

export type OutboxEventHandler = (event: OutboxEvent) => Promise<void>;

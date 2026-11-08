export interface ProductAuditEntry {
  aggregateType: string;
  aggregateId: string;
  revision: number | null;
  action: string;
  occurredAt: string;
  actor: unknown;
  reason: string | null;
  before: unknown;
  after: unknown;
}
export interface DeliveryStatus {
  id: string;
  needId: string;
  recipientId: string;
  channel: "email" | "telegram";
  template: string;
  attempts: number;
  acceptedAt: string | null;
  retryAfter: string | null;
  status: "pending" | "accepted" | "failed" | "obsolete";
}
export interface OperationalStatus {
  queuedSources: number;
  failedSources: number;
  oldestQueuedAt: string | null;
  unresolvedUrgentNeeds: number;
  overdueAcknowledgments: number;
  failedDeliveries: number;
  modelReservedMicroUsd: number;
  modelSettledMicroUsd: number;
  availableStorageBytes: number | null;
}

/** Shared DTOs and types used across apps. Schema-aligned types land here in later phases. */

export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthResponse {
  status: HealthStatus;
  service: string;
  timestamp: string;
}

export interface ApiErrorResponse {
  error: string;
  message?: string;
}

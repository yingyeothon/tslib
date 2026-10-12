import type { Logger } from "@yingyeothon/logger";
import type { PushServerFetchLike } from "./http.js";

export interface PushServerOptions {
  stateBaseUrl: string;
  consoleBaseUrl: string;
  channelId: string;
  apiKey: string;
  fetch?: PushServerFetchLike;
  logger?: Logger;
  /** Per HTTP request, including response body reads. Default 30000. */
  timeoutMs?: number;
}
export interface PushDeliveryOptions {
  priority?: "high" | "normal";
  ttlSec?: number;
  collapseKey?: string;
}
export interface PushSendOptions extends PushDeliveryOptions {
  userIds: string[];
  data?: Record<string, string>;
  notification?: { title: string; body: string };
}
export type PushRecipientResult =
  | { userId: string; status: "sent" | "no-token"; reason?: never }
  | {
      userId: string;
      status: "failed";
      reason: "budget" | "unavailable" | "rejected" | "unregistered";
    };
export interface PushSendResult {
  results: PushRecipientResult[];
  sent: number;
  noToken: number;
  failed: number;
}
export interface PushCreateUploadOptions {
  size: number;
  sha256?: string;
}
export interface PushUpload {
  uploadId: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: number;
  usableUntil: number;
  maxBytes: number;
}
export interface PushUploadEntry {
  id: string;
  size: number;
  createdBy: string;
  createdByLogin: string | null;
  createdAt: number;
  usableUntil: number;
  pending: boolean;
  inUse: boolean;
}
export interface PushListUploadsOptions {
  limit?: number;
  cursor?: string;
}
export interface PushUploadsPage {
  uploads: PushUploadEntry[];
  next: string | null;
  max: number;
}
export interface PushSubmitJobOptions extends PushDeliveryOptions {
  templateId: string;
  uploadId: string;
  idempotencyKey: string;
  dryRun?: boolean;
}
export interface PushJobCounts {
  resolved: number;
  sent: number;
  noToken: number;
  unregistered: number;
  failed: number;
  skipped: number;
  duplicates: number;
  missingVariables: number;
  invalid: number;
}
export interface PushJob {
  id: string;
  channelId: string;
  kind: "campaign" | "broadcast";
  dryRun: boolean;
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
  errorDetails: Record<string, unknown> | null;
  cancelRequested: boolean;
  idempotencyKey: string;
  templateId: string | null;
  uploadId: string | null;
  message: { title: string; body: string; data: Record<string, string> };
  options: PushDeliveryOptions;
  author: string;
  total: number | null;
  processed: number;
  counts: PushJobCounts;
  report: { available: boolean; expiresAt: number } | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}
export interface PushJobSubmission {
  job: PushJob;
  created: boolean;
}
export type PushListJobsOptions =
  | { limit?: number; cursor?: string; idempotencyKey?: never }
  | { idempotencyKey: string; limit?: never; cursor?: never };
export interface PushJobsPage {
  jobs: PushJob[];
  next: string | null;
}
export interface PushReportUrl {
  url: string;
  expiresAt: number;
  reportExpiresAt: number;
}
export type PushBroadcastOptions = PushDeliveryOptions & {
  idempotencyKey: string;
} & (
    | { templateId: string; title?: never; body?: never; data?: never }
    | {
        templateId?: never;
        title?: string;
        body?: string;
        data?: Record<string, string>;
      }
  );
export interface PushServer {
  send(options: PushSendOptions): Promise<PushSendResult>;
  createUpload(options: PushCreateUploadOptions): Promise<PushUpload>;
  listUploads(options?: PushListUploadsOptions): Promise<PushUploadsPage>;
  deleteUpload(uploadId: string): Promise<void>;
  submitJob(options: PushSubmitJobOptions): Promise<PushJobSubmission>;
  listJobs(options?: PushListJobsOptions): Promise<PushJobsPage>;
  getJob(jobId: string): Promise<PushJob>;
  cancelJob(jobId: string): Promise<PushJob>;
  getReportUrl(jobId: string): Promise<PushReportUrl>;
  broadcast(options: PushBroadcastOptions): Promise<PushJobSubmission>;
}

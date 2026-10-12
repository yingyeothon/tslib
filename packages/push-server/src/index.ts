import {
  baseUrl,
  createRequest,
  identifier,
  invalid,
  protect,
  record,
} from "./http.js";
import {
  bool,
  checked,
  deliveryOptions,
  httpUrl,
  idempotencyKey,
  integer,
  jobCheck,
  jobs,
  message,
  nullable,
  query,
  shape,
  string,
  strings,
  uploads,
} from "./validation.js";
import type {
  PushDeliveryOptions,
  PushServer,
  PushServerOptions,
  PushSendResult,
  PushUpload,
  PushUploadsPage,
  PushJob,
  PushJobSubmission,
  PushJobsPage,
  PushReportUrl,
} from "./types.js";

export { isPushServerError } from "./http.js";
export type {
  PushServerError,
  PushServerFetchLike,
  PushServerFetchRequest,
  PushServerFetchResponse,
} from "./http.js";
export type {
  PushServerOptions,
  PushDeliveryOptions,
  PushSendOptions,
  PushRecipientResult,
  PushSendResult,
  PushCreateUploadOptions,
  PushUpload,
  PushUploadEntry,
  PushListUploadsOptions,
  PushUploadsPage,
  PushSubmitJobOptions,
  PushJobCounts,
  PushJob,
  PushJobSubmission,
  PushListJobsOptions,
  PushJobsPage,
  PushReportUrl,
  PushBroadcastOptions,
  PushServer,
} from "./types.js";

function delivery(options: PushDeliveryOptions): PushDeliveryOptions {
  deliveryOptions(options);
  return {
    priority: options.priority,
    ttlSec: options.ttlSec,
    collapseKey: options.collapseKey,
  };
}
const submissionCheck = shape({ job: jobCheck, created: bool });
const recipientCheck = (v: unknown): boolean =>
  record(v) &&
  typeof v.userId === "string" &&
  (v.status === "sent" ||
    v.status === "no-token" ||
    (v.status === "failed" &&
      ["budget", "unavailable", "rejected", "unregistered"].includes(
        v.reason as string,
      )));

export function createPushServer(options: PushServerOptions): PushServer {
  const channelId = identifier(options.channelId);
  const state = `${baseUrl(options.stateBaseUrl)}/push/${channelId}`;
  const consoleBase = `${baseUrl(options.consoleBaseUrl)}/push-api/${channelId}`;
  const request = createRequest({ ...options, token: options.apiKey });
  async function call<T>(
    url: string,
    method: string,
    expected: number[],
    check: (value: unknown) => boolean,
    body?: unknown,
  ): Promise<T> {
    const response = await request(url, method, expected, body);
    return checked<T>(response.data, check, response.status);
  }
  return protect<PushServer>({
    async send(options) {
      if (
        !Array.isArray(options.userIds) ||
        options.userIds.length < 1 ||
        options.userIds.length > 500 ||
        options.userIds.some((id) => typeof id !== "string" || !id)
      )
        throw invalid("Push send requires 1–500 userIds");
      message(options);
      return call<PushSendResult>(
        `${state}/send`,
        "POST",
        [200],
        shape({
          results: (v) => Array.isArray(v) && v.every(recipientCheck),
          sent: integer,
          noToken: integer,
          failed: integer,
        }),
        {
          ...delivery(options),
          userIds: options.userIds,
          data: options.data,
          notification: options.notification,
        },
      );
    },
    async createUpload({ size, sha256 }) {
      if (
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > 102401024 ||
        (sha256 !== undefined &&
          (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)))
      )
        throw invalid("Invalid push upload");
      return call<PushUpload>(
        `${consoleBase}/uploads`,
        "POST",
        [201],
        shape({
          uploadId: string,
          url: httpUrl,
          method: (v) => v === "PUT",
          headers: strings,
          expiresAt: integer,
          usableUntil: integer,
          maxBytes: integer,
        }),
        { size, sha256 },
      );
    },
    async listUploads(options = {}) {
      return call<PushUploadsPage>(
        `${consoleBase}/uploads${query(options)}`,
        "GET",
        [200],
        shape({ uploads, next: nullable(string), max: integer }),
      );
    },
    async deleteUpload(uploadId) {
      await request(
        `${consoleBase}/uploads/${identifier(uploadId)}`,
        "DELETE",
        [204],
      );
    },
    async submitJob(options) {
      identifier(options.templateId);
      identifier(options.uploadId);
      idempotencyKey(options.idempotencyKey);
      if (options.dryRun !== undefined && typeof options.dryRun !== "boolean")
        throw invalid("Invalid push dryRun");
      return call<PushJobSubmission>(
        `${consoleBase}/jobs`,
        "POST",
        [200, 202],
        submissionCheck,
        {
          ...delivery(options),
          templateId: options.templateId,
          uploadId: options.uploadId,
          idempotencyKey: options.idempotencyKey,
          dryRun: options.dryRun,
        },
      );
    },
    async listJobs(options = {}) {
      return call<PushJobsPage>(
        `${consoleBase}/jobs${query(options)}`,
        "GET",
        [200],
        shape({ jobs, next: nullable(string) }),
      );
    },
    async getJob(jobId) {
      return (
        await call<{ job: PushJob }>(
          `${consoleBase}/jobs/${identifier(jobId)}`,
          "GET",
          [200],
          shape({ job: jobCheck }),
        )
      ).job;
    },
    async cancelJob(jobId) {
      return (
        await call<{ job: PushJob }>(
          `${consoleBase}/jobs/${identifier(jobId)}/cancel`,
          "POST",
          [200],
          shape({ job: jobCheck }),
        )
      ).job;
    },
    async getReportUrl(jobId) {
      return call<PushReportUrl>(
        `${consoleBase}/jobs/${identifier(jobId)}/report`,
        "GET",
        [200],
        shape({ url: httpUrl, expiresAt: integer, reportExpiresAt: integer }),
      );
    },
    async broadcast(options) {
      idempotencyKey(options.idempotencyKey);
      const transport = delivery(options);
      let payload: unknown;
      if (options.templateId !== undefined) {
        identifier(options.templateId);
        if (
          options.title !== undefined ||
          options.body !== undefined ||
          options.data !== undefined
        )
          throw invalid("Broadcast requires template or inline message");
        payload = {
          ...transport,
          idempotencyKey: options.idempotencyKey,
          templateId: options.templateId,
        };
      } else {
        if (
          (options.title !== undefined && typeof options.title !== "string") ||
          (options.body !== undefined && typeof options.body !== "string")
        )
          throw invalid("Invalid broadcast text");
        message({
          data: options.data,
          notification: options.title
            ? { title: options.title, body: options.body ?? "" }
            : undefined,
        });
        if (options.body && !options.title)
          throw invalid("Broadcast body requires a title");
        payload = {
          ...transport,
          idempotencyKey: options.idempotencyKey,
          title: options.title,
          body: options.body,
          data: options.data,
        };
      }
      return call<PushJobSubmission>(
        `${consoleBase}/broadcast`,
        "POST",
        [200, 202],
        submissionCheck,
        payload,
      );
    },
  });
}

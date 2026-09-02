import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";

import {
  authorizationHeader,
  buildQueryParams,
  httpRequest,
  makeBodyAsBuffer,
} from "./internal.js";
import type {
  FetchOptions,
  JSONModificationRequest,
  LockOptions,
  S3cbClientOptions,
  SyncOptions,
} from "./types.js";

export interface S3cbClient {
  get: (key: string, options?: LockOptions) => Promise<string>;
  put: (
    key: string,
    body: string | Buffer | Uint8Array,
    options?: LockOptions & SyncOptions,
  ) => Promise<string>;
  del: (key: string, options?: LockOptions) => Promise<string>;
  append: (
    key: string,
    body: string,
    options?: LockOptions & SyncOptions,
  ) => Promise<string>;
  sync: (key: string) => Promise<string>;
  invalidate: (key: string) => Promise<string>;
  lock: (key: string) => Promise<string>;
  unlock: (key: string) => Promise<string>;
  patch: <T>(
    key: string,
    modRequest: JSONModificationRequest,
    options?: LockOptions & SyncOptions & FetchOptions,
  ) => Promise<T | null>;
  getBuffer: (key: string, options?: LockOptions) => Promise<Buffer>;
  download: (
    key: string,
    downloadPath: string,
    options?: LockOptions,
  ) => Promise<string>;
  exists: (key: string, options?: LockOptions) => Promise<boolean>;
}

export function s3cbClientOptionsFromEnv(): S3cbClientOptions {
  const apiUrl = process.env.S3CB_URL;
  if (apiUrl === undefined) {
    throw new Error("S3CB_URL environment variable is not set");
  }
  return {
    apiUrl,
    apiId: process.env.S3CB_ID,
    apiPassword: process.env.S3CB_PASSWORD,
  };
}

export function createS3cbClient(options: S3cbClientOptions): S3cbClient {
  const headers = () => authorizationHeader(options);
  // Every call hits `<apiUrl><key>?<params>` with the same credentials;
  // only the method, body and response handling differ per operation.
  const request = <R = string>(
    key: string,
    method: string,
    params: Parameters<typeof buildQueryParams>[0],
    extra: Pick<
      Parameters<typeof httpRequest<R>>[0],
      "body" | "handleResponse"
    > = {},
  ): Promise<R> =>
    httpRequest<R>({
      url: options.apiUrl + key + buildQueryParams(params),
      method,
      headers: headers(),
      ...extra,
    });

  const get = (key: string, { noLock = false }: LockOptions = {}) =>
    request(key, "GET", { noLock });

  const put = (
    key: string,
    body: string | Buffer | Uint8Array,
    { noLock = false, sync = false }: LockOptions & SyncOptions = {},
  ) =>
    // Note: unlike the legacy client, Content-Length is not set manually;
    // fetch derives the identical value from the buffered body, and setting
    // it explicitly would duplicate the header on the wire.
    request(key, "PUT", { noLock, sync }, { body: makeBodyAsBuffer(body) });

  const del = (key: string, { noLock = false }: LockOptions = {}) =>
    request(key, "DELETE", { noLock });

  const append = (
    key: string,
    body: string,
    { noLock = false, sync = false }: LockOptions & SyncOptions = {},
  ) =>
    request(
      key,
      "PUT",
      { append: true, noLock, sync },
      { body: makeBodyAsBuffer(body) },
    );

  const sync = (key: string) => request(key, "POST", { sync: true });

  const invalidate = (key: string) => request(key, "DELETE", { cache: true });

  const lock = (key: string) => request(key, "POST", { lock: "acquire" });

  const unlock = (key: string) => request(key, "POST", { lock: "release" });

  const patch = <T>(
    key: string,
    modRequest: JSONModificationRequest,
    {
      noLock = false,
      sync = false,
      fetch = modRequest.operation === "fetch",
    }: LockOptions & SyncOptions & FetchOptions = {},
  ): Promise<T | null> =>
    request(
      key,
      "PATCH",
      { noLock, sync, fetch },
      {
        body: makeBodyAsBuffer(JSON.stringify(modRequest)),
      },
    ).then((response) => {
      if (!fetch) {
        return null;
      }
      const value = JSON.parse(response) as {
        _ok: boolean;
        error?: string;
        result?: T;
      };
      if (!value._ok) {
        throw new Error(value.error);
      }
      return value.result as T;
    });

  const getBuffer = (key: string, { noLock = false }: LockOptions = {}) =>
    request(
      key,
      "GET",
      { noLock },
      {
        handleResponse: (response) =>
          response.body !== null
            ? buffer(response.body)
            : Promise.resolve(Buffer.alloc(0)),
      },
    );

  const download = (
    key: string,
    downloadPath: string,
    { noLock = false }: LockOptions = {},
  ): Promise<string> =>
    request(
      key,
      "GET",
      { noLock },
      {
        handleResponse: async (response) => {
          const source =
            response.body !== null
              ? Readable.fromWeb(response.body)
              : Readable.from([]);
          await pipeline(source, createWriteStream(downloadPath));
          return downloadPath;
        },
      },
    );

  const exists = (
    key: string,
    { noLock = false }: LockOptions = {},
  ): Promise<boolean> =>
    request(key, "HEAD", { noLock })
      .then(() => true)
      .catch((error: Error) => {
        if (/^404 /.test(error.message)) {
          return false;
        }
        throw error;
      });

  return {
    get,
    put,
    del,
    append,
    sync,
    invalidate,
    lock,
    unlock,
    patch,
    getBuffer,
    download,
    exists,
  };
}

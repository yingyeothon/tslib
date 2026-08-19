export interface S3cbEnv {
  apiUrl: string;
  apiId?: string;
  apiPassword?: string;
}

export interface LockOptions {
  noLock?: boolean;
}

export interface SyncOptions {
  sync?: boolean;
}

export interface FetchOptions {
  fetch?: boolean;
}

type SingleValue = string | number;
type KeyValue = { [key: string]: ResourceValue };
type ArrayValue = ResourceValue[];
type ResourceValue = KeyValue | ArrayValue | SingleValue;

interface AppendOperationRequest {
  operation: "append";
  path: string;
  value: KeyValue | ArrayValue;
  upsert?: boolean;
}

interface ModifyOperationRequest {
  operation: "modify";
  path: string;
  value: KeyValue | ArrayValue;
}

interface RemoveOperationRequest {
  operation: "remove";
  path: string;
  key?: string[];
}

interface FetchOperationRequest {
  operation: "fetch";
  path: string;
  key?: string[];
}

export type JSONModificationRequest =
  | AppendOperationRequest
  | ModifyOperationRequest
  | RemoveOperationRequest
  | FetchOperationRequest;

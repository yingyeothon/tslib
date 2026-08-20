import { S3 } from "@aws-sdk/client-s3";
import type { Codec } from "@yingyeothon/codec";
import {
  createRepositoryFromKV,
  type KVPrimitives,
  type Repository,
} from "@yingyeothon/repository";

export interface S3RepositoryOptions {
  bucketName: string;
  s3?: S3;
  prefix?: string;
  codec?: Codec<string>;
}

export interface S3Repository extends Repository {
  withPrefix(prefix: string): S3Repository;
}

const NO_SUCH_KEY_MESSAGE = /The specified key does not exist\./;

function isNoSuchKeyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "NoSuchKey" || NO_SUCH_KEY_MESSAGE.test(error.message))
  );
}

export function createS3Repository(options: S3RepositoryOptions): S3Repository {
  const { bucketName, prefix = "", codec } = options;
  const s3 = options.s3 ?? new S3();

  function asS3Key(key: string): string {
    return prefix ? `${prefix}${key}` : key;
  }

  // `createRepositoryFromKV` speaks JSON strings; a custom codec re-encodes
  // that serialized form so the stored object keeps the codec's encoding.
  const toBody = codec
    ? (serialized: string) => codec.encode(JSON.parse(serialized))
    : (serialized: string) => serialized;
  const fromBody = codec
    ? (body: string) => JSON.stringify(codec.decode(body))
    : (body: string) => body;

  const primitives: KVPrimitives = {
    async get(key) {
      try {
        const content = await s3.getObject({
          Bucket: bucketName,
          Key: asS3Key(key),
        });
        if (!content.Body) {
          return undefined;
        }
        return fromBody(await content.Body.transformToString("utf-8"));
      } catch (error) {
        // Without the `listObject` permission, S3 reports a missing key as
        // "Access Denied" instead of "NoSuchKey"; that error is rethrown.
        if (!isNoSuchKeyError(error)) {
          throw error;
        }
      }
      return undefined;
    },
    async set(key, serialized) {
      await s3.putObject({
        Bucket: bucketName,
        Key: asS3Key(key),
        Body: toBody(serialized),
      });
    },
    async delete(key) {
      await s3.deleteObject({
        Bucket: bucketName,
        Key: asS3Key(key),
      });
    },
  };

  const repository = createRepositoryFromKV(primitives);
  return {
    ...repository,
    set<T>(key: string, value: T): Promise<void> {
      if (value === undefined) {
        return repository.delete(key);
      }
      return repository.set(key, value);
    },
    withPrefix(nextPrefix: string): S3Repository {
      return createS3Repository({ bucketName, s3, prefix: nextPrefix, codec });
    },
  };
}

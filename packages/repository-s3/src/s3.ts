import { S3 } from "@aws-sdk/client-s3";
import { JsonCodec, type Codec } from "@yingyeothon/codec";
import { SimpleRepository } from "@yingyeothon/repository";

export interface S3RepositoryArguments {
  bucketName: string;
  s3?: S3;
  prefix?: string;
  codec?: Codec<string>;
}

const NO_SUCH_KEY_MESSAGE = /The specified key does not exist\./;

function isNoSuchKeyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "NoSuchKey" || NO_SUCH_KEY_MESSAGE.test(error.message))
  );
}

export class S3Repository extends SimpleRepository {
  private readonly bucketName: string;
  private readonly s3: S3;
  private readonly prefix: string;
  private readonly codec: Codec<string>;

  constructor({ bucketName, s3, prefix, codec }: S3RepositoryArguments) {
    super();
    this.bucketName = bucketName;
    this.s3 = s3 ?? new S3();
    this.prefix = prefix ?? "";
    this.codec = codec ?? new JsonCodec();
  }

  public async get<T>(key: string): Promise<T | undefined> {
    try {
      const content = await this.s3.getObject({
        Bucket: this.bucketName,
        Key: this.asS3Key(key),
      });
      if (!content.Body) {
        return undefined;
      }
      const encoded = await content.Body.transformToString("utf-8");
      return this.codec.decode<T>(encoded);
    } catch (error) {
      // Without the `listObject` permission, S3 reports a missing key as
      // "Access Denied" instead of "NoSuchKey"; that error is rethrown.
      if (!isNoSuchKeyError(error)) {
        throw error;
      }
    }
    return undefined;
  }

  public async set<T>(key: string, value: T): Promise<void> {
    if (value === undefined) {
      return this.delete(key);
    }
    await this.s3.putObject({
      Bucket: this.bucketName,
      Key: this.asS3Key(key),
      Body: this.codec.encode(value),
    });
  }

  public async delete(key: string): Promise<void> {
    await this.s3.deleteObject({
      Bucket: this.bucketName,
      Key: this.asS3Key(key),
    });
  }

  public withPrefix(prefix: string): S3Repository {
    return new S3Repository({
      bucketName: this.bucketName,
      s3: this.s3,
      prefix,
      codec: this.codec,
    });
  }

  private asS3Key(key: string): string {
    return this.prefix ? `${this.prefix}${key}` : key;
  }
}

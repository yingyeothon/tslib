import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  type PutCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { Codec } from "@yingyeothon/codec";
import {
  createRepositoryFromKV,
  type CasRepository,
  type ExpirableRepository,
  type KVPrimitives,
} from "@yingyeothon/repository";
import { randomUUID } from "node:crypto";

export interface DynamoRepositoryOptions {
  tableName: string;
  /** Defaults to `DynamoDBDocumentClient.from(new DynamoDBClient())`. */
  client?: DynamoDBDocumentClient;
  prefix?: string;
  codec?: Codec<string>;
  /** Partition key attribute of the table. Default `"pk"`. */
  keyAttribute?: string;
  /** Attribute the table's TTL is enabled on (epoch seconds). Default `"ttl"`. */
  ttlAttribute?: string;
}

export interface DynamoRepository extends ExpirableRepository, CasRepository {
  withPrefix(prefix: string): DynamoRepository;
}

interface StoredItem {
  value: string;
  rev: string;
  [attribute: string]: unknown;
}

const ttlRequiredMessage =
  "@yingyeothon/repository-dynamodb needs a positive expiresInMillis to expire a key.";

function assertTtl(expiresInMillis: number): void {
  if (!(expiresInMillis > 0)) {
    throw new Error(ttlRequiredMessage);
  }
}

function isConditionFailure(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "ConditionalCheckFailedException"
  );
}

export function createDynamoRepository(
  options: DynamoRepositoryOptions,
): DynamoRepository {
  const {
    tableName,
    prefix = "",
    codec,
    keyAttribute = "pk",
    ttlAttribute = "ttl",
  } = options;
  const client =
    options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient());

  function asItemKey(key: string): string {
    return prefix ? `${prefix}${key}` : key;
  }

  function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  function expiresAt(expiresInMillis: number): number {
    return Math.ceil((Date.now() + expiresInMillis) / 1000);
  }

  // `createRepositoryFromKV` speaks JSON strings; a custom codec re-encodes
  // that serialized form so the stored attribute keeps the codec's encoding.
  const toValue = codec
    ? (serialized: string) => codec.encode(JSON.parse(serialized))
    : (serialized: string) => serialized;
  const fromValue = codec
    ? (value: string) => JSON.stringify(codec.decode(value))
    : (value: string) => value;

  // DynamoDB deletes expired items lazily (typically within 48 hours), so a
  // read must apply the TTL itself to hide such a ghost.
  function isLive(item: StoredItem): boolean {
    const ttl = item[ttlAttribute];
    return typeof ttl !== "number" || ttl >= nowSeconds();
  }

  async function readItem(key: string): Promise<StoredItem | undefined> {
    const output = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { [keyAttribute]: asItemKey(key) },
      }),
    );
    const item = output.Item as StoredItem | undefined;
    if (item === undefined || typeof item.value !== "string") {
      return undefined;
    }
    return isLive(item) ? item : undefined;
  }

  function newItem(
    key: string,
    serialized: string,
    expiresInMillis?: number,
  ): StoredItem {
    return {
      [keyAttribute]: asItemKey(key),
      value: toValue(serialized),
      rev: randomUUID(),
      ...(expiresInMillis === undefined
        ? {}
        : { [ttlAttribute]: expiresAt(expiresInMillis) }),
    };
  }

  const primitives: Required<KVPrimitives> = {
    async get(key) {
      const item = await readItem(key);
      return item === undefined ? undefined : fromValue(item.value);
    },
    async set(key, serialized) {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: newItem(key, serialized),
        }),
      );
    },
    async setWithExpire(key, serialized, expiresInMillis) {
      assertTtl(expiresInMillis);
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: newItem(key, serialized, expiresInMillis),
        }),
      );
    },
    async delete(key) {
      await client.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { [keyAttribute]: asItemKey(key) },
        }),
      );
    },
    async getRevision(key) {
      const item = await readItem(key);
      if (item === undefined) {
        return undefined;
      }
      return { serialized: fromValue(item.value), token: item.rev };
    },
    async compareAndSet(key, expectedToken, serialized, expiresInMillis) {
      if (expiresInMillis !== undefined) {
        assertTtl(expiresInMillis);
      }
      // An expired item that DynamoDB has not swept yet still exists in the
      // table: "absent" must also accept such a ghost, and a token read from
      // a ghost before it expired must not be accepted afterwards.
      const condition: Pick<
        PutCommandInput,
        | "ConditionExpression"
        | "ExpressionAttributeNames"
        | "ExpressionAttributeValues"
      > =
        expectedToken === undefined
          ? {
              ConditionExpression: "attribute_not_exists(#pk) OR #ttl < :now",
              ExpressionAttributeNames: {
                "#pk": keyAttribute,
                "#ttl": ttlAttribute,
              },
              ExpressionAttributeValues: { ":now": nowSeconds() },
            }
          : {
              ConditionExpression:
                "#rev = :rev AND (attribute_not_exists(#ttl) OR #ttl >= :now)",
              ExpressionAttributeNames: { "#rev": "rev", "#ttl": ttlAttribute },
              ExpressionAttributeValues: {
                ":rev": expectedToken,
                ":now": nowSeconds(),
              },
            };
      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: newItem(key, serialized, expiresInMillis),
            ...condition,
          }),
        );
        return true;
      } catch (error) {
        if (isConditionFailure(error)) {
          return false;
        }
        throw error;
      }
    },
  };

  const repository = createRepositoryFromKV(primitives);
  return {
    ...repository,
    // Deliberately mirrors `repository-s3`: `undefined` deletes rather than
    // throwing. Kept local so `@yingyeothon/repository` gains no export for it.
    set<T>(key: string, value: T): Promise<void> {
      if (value === undefined) {
        return repository.delete(key);
      }
      return repository.set(key, value);
    },
    withPrefix(nextPrefix: string): DynamoRepository {
      return createDynamoRepository({
        tableName,
        client,
        prefix: nextPrefix,
        codec,
        keyAttribute,
        ttlAttribute,
      });
    },
  };
}

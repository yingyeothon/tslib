/**
 * Messages requested to an actor may be processed late.
 * This policy is kind of how long to wait for it.
 */
export enum AwaitPolicy {
  /**
   * I don't want to wait anything.
   * But it doesn't ensure it will finish immediately because this thread
   * can process all of messages from this actor's queue in bad luck.
   */
  Forget,

  /**
   * I want to wait only until the completion of `act` call of my message.
   * But it doesn't ensure this modification is committed completely.
   */
  Act,

  /**
   * I want to wait until the completion of `after-act` call.
   * It will ensure that my message would be completed perfectly,
   * but because of this it may take a long time.
   */
  Commit,
}

/** Metadata used to await and resolve the completion of a message. */
export interface AwaiterMeta {
  messageId: string;
  awaitPolicy: AwaitPolicy;
  awaitTimeoutMillis: number;
}

/** Metadata attached to a user message. */
export type UserMessageMeta = AwaiterMeta;

/** The user payload of a message. */
export interface UserMessageItem<T> {
  item: T;
}

/** A message stored in an actor's queue: user payload plus metadata. */
export interface UserMessage<T> extends UserMessageItem<T>, AwaiterMeta {}

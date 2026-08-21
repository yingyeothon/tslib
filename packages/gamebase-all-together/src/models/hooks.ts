import type {
  BaseGameContext,
  NetworkOptions,
} from "@yingyeothon/lambda-gamebase";
import type { GameStage } from "./GameStage.js";
import type { GameEndReason } from "./GameTickPolicy.js";

/**
 * Points where the game loop hands control back to the game.
 *
 * This package decides **when** something happens; each hook decides
 * **what** — if anything — reaches the clients, in whatever shape the
 * game's own protocol uses. `network` is threaded through so a hook can
 * call `broadcast`/`reply` from `@yingyeothon/lambda-gamebase` without
 * capturing anything itself.
 *
 * Leaving `onStageChanged` and `onMemberEntered` unset keeps the messages
 * this package has always sent; setting them replaces those messages
 * entirely, and a no-op silences them.
 */
export interface GameHooks {
  /** Once per second while a stage runs, and once when the game ends. */
  onStageChanged?: (options: StageChangedOptions) => Promise<unknown>;
  /**
   * When a member's connection is bound, including on a reconnect — the
   * place to send that member a full state snapshot.
   */
  onMemberEntered?: (options: MemberEnteredOptions) => Promise<unknown>;
  /**
   * Every `snapshotIntervalMillis` during the running stage. Nothing is
   * sent unless this is set: the snapshot format belongs to the game.
   */
  onSnapshot?: (options: SnapshotOptions) => Promise<unknown>;
  /** After the game loop stops, before the end stage and the disconnects. */
  onGameEnd?: (options: GameEndOptions) => Promise<unknown>;
}

export interface StageChangedOptions {
  context: BaseGameContext;
  stage: GameStage;
  /** Whole seconds elapsed in this stage. */
  age: number;
  network?: NetworkOptions;
}

export interface MemberEnteredOptions {
  context: BaseGameContext;
  connectionId: string;
  memberId: string;
  network?: NetworkOptions;
}

export interface SnapshotOptions {
  context: BaseGameContext;
  /** Milliseconds elapsed since the running stage began. */
  elapsedMillis: number;
  network?: NetworkOptions;
}

export interface GameEndOptions {
  context: BaseGameContext;
  reason: GameEndReason;
  network?: NetworkOptions;
}

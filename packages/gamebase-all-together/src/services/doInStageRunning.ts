import {
  createTicker,
  createTimeDelta,
  sleep,
  type BaseGameContext,
  type BaseGameRequest,
  type NetworkOptions,
} from "@yingyeothon/lambda-gamebase";
import { nullLogger, type Logger } from "@yingyeothon/logger";
import { GameStage } from "../models/GameStage.js";
import type { GameTickPolicy } from "../models/GameTickPolicy.js";
import type { GameHooks } from "../models/hooks.js";
import { createStageAnnouncer } from "./createStageAnnouncer.js";
import { describeGame } from "./describeGame.js";
import { processEnterLeave } from "./processEnterLeave.js";

/**
 * A game message: enter/leave requests plus any game-specific requests
 * carrying a `type` and the sender's `connectionId`.
 */
export type GameMessageBase = { type: string; connectionId: string };

export interface GameController<M extends GameMessageBase> {
  isGameOver: ({ context }: { context: BaseGameContext }) => boolean;
  processMessage: ({
    context,
    message,
  }: {
    context: BaseGameContext;
    message: M;
  }) => Promise<unknown>;
  /**
   * Advances the simulation by `delta` seconds. When the tick policy is
   * `fixed`, `delta` is constant and this runs whether or not messages
   * arrived; when it is `perMessage`, `delta` is the time since the
   * previous call and this runs once per processed message.
   */
  updateTimeDelta?: ({
    context,
    delta,
  }: {
    context: BaseGameContext;
    delta: number;
  }) => Promise<unknown>;
}

const defaultMaxCatchUpSteps = 5;
const defaultTick: GameTickPolicy = { mode: "perMessage" };

export type DoInStageRunningOptions<M extends GameMessageBase> = {
  context: BaseGameContext;
  gameRunningSeconds: number;
  /**
   * Milliseconds to sleep between queue polls. Ignored by the `fixed`
   * tick policy, which paces itself by its own interval.
   */
  pollIntervalMillis: number;
  /** Defaults to `{ mode: "perMessage" }`. */
  tick?: GameTickPolicy;
  /** How often {@link GameHooks.onSnapshot} runs; unset means never. */
  snapshotIntervalMillis?: number;
  /** Unbind connections a stage broadcast could not reach. */
  dropUndeliveredConnections?: boolean;
  pollMessages: () => Promise<M[]>;
  logger?: Logger;
  /** Network options (gamebase context or explicit client) for broadcasts. */
  network?: NetworkOptions;
} & GameController<M> &
  Pick<GameHooks, "onStageChanged" | "onMemberEntered" | "onSnapshot">;

/**
 * Running stage: dispatches enter/leave and game messages to the game
 * controller until the game is over or the running time runs out, driving
 * the simulation according to the tick policy and announcing the stage age
 * once per second.
 */
export async function doInStageRunning<M extends GameMessageBase>({
  context,
  gameRunningSeconds,
  pollIntervalMillis,
  tick = defaultTick,
  snapshotIntervalMillis,
  dropUndeliveredConnections = false,
  isGameOver,
  processMessage,
  updateTimeDelta,
  pollMessages,
  logger = nullLogger,
  network,
  onStageChanged,
  onMemberEntered,
  onSnapshot,
}: DoInStageRunningOptions<M>): Promise<void> {
  if (tick.mode === "fixed") {
    // `0` is not nullish, so `maxCatchUpSteps: 0` would slip past the
    // default and stop the simulation for the whole game; `intervalMillis:
    // 0` would step forever with a zero delta and never sleep.
    if (!(tick.intervalMillis > 0)) {
      throw new Error("tick.intervalMillis must be greater than 0");
    }
    if (tick.maxCatchUpSteps !== undefined && !(tick.maxCatchUpSteps >= 1)) {
      throw new Error("tick.maxCatchUpSteps must be at least 1");
    }
  }

  logger.info("Start of running stage", { ...describeGame(context), tick });

  const timeDelta = createTimeDelta();
  const announce = createStageAnnouncer({
    dropUndeliveredConnections,
    ...(onStageChanged ? { onStageChanged } : {}),
  });
  const ticker = createTicker<GameStage>({
    stage: GameStage.Running,
    aliveMillis: gameRunningSeconds * 1000,
  });

  const startedMillis = Date.now();
  let lastStepMillis = startedMillis;
  let lastSnapshotMillis = startedMillis;
  let owedMillis = 0;

  /**
   * Converts elapsed wall-clock time into whole simulation steps. Time
   * left over stays owed, so the simulation never drifts away from the
   * clock the way a plain sleep-based loop does.
   */
  async function runFixedSteps(): Promise<number> {
    if (tick.mode !== "fixed" || updateTimeDelta === undefined) {
      return 0;
    }
    const { intervalMillis } = tick;
    const maxSteps = tick.maxCatchUpSteps ?? defaultMaxCatchUpSteps;
    const delta = intervalMillis / 1000;

    const now = Date.now();
    owedMillis += now - lastStepMillis;
    lastStepMillis = now;

    let steps = 0;
    let stopped = false;
    while (owedMillis >= intervalMillis && steps < maxSteps) {
      owedMillis -= intervalMillis;
      ++steps;
      try {
        await updateTimeDelta({ context, delta });
      } catch (error) {
        logger.error("Cannot update with time-delta", {
          ...describeGame(context),
          delta,
          error,
        });
      }
      if (isGameOver({ context })) {
        stopped = true;
        break;
      }
    }
    // Time still owed when the game just ended is not a backlog.
    if (!stopped && owedMillis >= intervalMillis) {
      // The loop cannot keep up; dropping the backlog keeps it responsive
      // instead of falling further behind on every pass.
      logger.warn("Game tick overrun", {
        droppedTicks: Math.floor(owedMillis / intervalMillis),
        owedMillis,
        intervalMillis,
      });
      owedMillis = 0;
    }
    return steps;
  }

  async function sendSnapshotIfDue(): Promise<void> {
    if (onSnapshot === undefined || snapshotIntervalMillis === undefined) {
      return;
    }
    const now = Date.now();
    if (now - lastSnapshotMillis < snapshotIntervalMillis) {
      return;
    }
    lastSnapshotMillis = now;
    try {
      await onSnapshot({
        context,
        elapsedMillis: now - startedMillis,
        network,
      });
    } catch (error) {
      logger.error("Cannot send a snapshot", {
        ...describeGame(context),
        error,
      });
    }
  }

  while (ticker.isAlive() && !isGameOver({ context })) {
    const loopStartedMillis = Date.now();
    const messages = await pollMessages();
    for (const message of messages) {
      try {
        if (message.type === "enter" || message.type === "leave") {
          await processEnterLeave({
            context,
            message: message as unknown as BaseGameRequest,
            network,
            ...(onMemberEntered ? { onMemberEntered } : {}),
          });
        } else {
          await processMessage({ context, message });
        }
      } catch (error) {
        logger.error("Cannot process message", {
          ...describeGame(context),
          type: message.type,
          error,
        });
      }
      if (tick.mode === "perMessage" && updateTimeDelta) {
        const delta = timeDelta.getDelta();
        try {
          await updateTimeDelta({ context, delta });
        } catch (error) {
          logger.error("Cannot update with time-delta", {
            ...describeGame(context),
            delta,
            error,
          });
        }
      }
    }

    const steps = await runFixedSteps();
    if (isGameOver({ context })) {
      // No snapshot of a finished game, and no full tick of dead time
      // before `runGameAllTogether` can report the result.
      break;
    }
    await sendSnapshotIfDue();
    await ticker.checkAgeChanged((stage, age) =>
      announce({ context, stage, age, network }),
    );

    const sleepMillis =
      tick.mode === "fixed"
        ? Math.max(0, tick.intervalMillis - (Date.now() - loopStartedMillis))
        : pollIntervalMillis;
    logger.debug("Game tick", {
      messageCount: messages.length,
      steps,
      owedMillis,
      sleepMillis,
    });
    await sleep(sleepMillis);
  }

  logger.info("End of running stage", describeGame(context));
}

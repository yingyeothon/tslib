/**
 * How the running stage advances the game simulation.
 *
 * - `perMessage` reports the wall-clock time elapsed since the previous
 *   call, once per processed message. Turn-based games want this: nothing
 *   moves unless somebody acts.
 * - `fixed` steps the simulation in constant `intervalMillis` slices,
 *   independent of traffic, so monster AI, damage over time, and cooldowns
 *   keep running while the party stands still. The constant delta also
 *   makes the simulation deterministic and therefore replayable.
 */
export type GameTickPolicy =
  | { mode: "perMessage" }
  | {
      mode: "fixed";
      /** Simulation step and target loop period, in milliseconds. */
      intervalMillis: number;
      /**
       * Upper bound on steps run in one loop to catch up after a stall.
       * Without it a slow loop would spiral: each pass would owe more
       * simulation than it can run. Default: 5.
       */
      maxCatchUpSteps?: number;
    };

/** Why the game loop stopped, as decided by the library. */
export type GameEndReason =
  /**
   * `isGameOver` returned true. That is the game's own verdict, so a
   * controller whose predicate is "everybody left" reports that as
   * `cleared` too; distinguish outcomes inside `onGameEnd` if it matters.
   */
  | "cleared"
  /** The running stage ran out of time. */
  | "timeout"
  /** The wait stage ended below `minPlayers`, so the game never ran. */
  | "notEnoughPlayers"
  /** A stage threw and the game was abandoned. */
  | "error";

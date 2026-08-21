import type { GameHooks, StageChangedOptions } from "../models/hooks.js";
import { broadcastStage, pruneUndeliveredUsers } from "./broadcastStage.js";

export interface StageAnnouncerOptions extends Pick<
  GameHooks,
  "onStageChanged"
> {
  dropUndeliveredConnections?: boolean;
}

/**
 * Resolves the stage announcement into one callable: the caller's
 * `onStageChanged`, or {@link broadcastStage} — which alone reports
 * delivery, so pruning unreachable connections only applies to it. A
 * custom hook owns that decision and can call `pruneUndeliveredUsers`.
 */
export function createStageAnnouncer({
  onStageChanged,
  dropUndeliveredConnections = false,
}: StageAnnouncerOptions): (options: StageChangedOptions) => Promise<unknown> {
  if (onStageChanged) {
    return onStageChanged;
  }
  return async (options) => {
    const delivered = await broadcastStage(options);
    if (dropUndeliveredConnections) {
      pruneUndeliveredUsers({ context: options.context, delivered });
    }
  };
}

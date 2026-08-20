import type { BaseGameObserver } from "./BaseGameObserver.js";
import type { BaseGameUser } from "./BaseGameUser.js";

export interface BaseGameContext {
  readonly users: BaseGameUser[];
  readonly observers: BaseGameObserver[];
  readonly connectedUsers: { [connectionId: string]: BaseGameUser };
}

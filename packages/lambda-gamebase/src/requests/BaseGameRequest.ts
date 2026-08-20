import type { BaseGameEnterRequest } from "./BaseGameEnterRequest.js";
import type { BaseGameLeaveRequest } from "./BaseGameLeaveRequest.js";

export type BaseGameRequest = BaseGameEnterRequest | BaseGameLeaveRequest;

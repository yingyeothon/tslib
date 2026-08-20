import type { BaseGameConnectionIdRequest } from "./BaseGameConnectionIdRequest.js";

export interface BaseGameLeaveRequest extends BaseGameConnectionIdRequest {
  type: "leave";
}

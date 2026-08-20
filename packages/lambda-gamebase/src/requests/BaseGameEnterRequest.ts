import type { BaseGameConnectionIdRequest } from "./BaseGameConnectionIdRequest.js";

export interface BaseGameEnterRequest extends BaseGameConnectionIdRequest {
  type: "enter";
  memberId: string;
}

import type { Logger } from "@yingyeothon/logger";
import {
  invalid,
  protect,
  baseUrl,
  createRequest,
  identifier,
  type PushClientFetchLike,
} from "./http.js";

export { isPushClientError } from "./http.js";
export type {
  PushClientError,
  PushClientFetchLike,
  PushClientFetchRequest,
  PushClientFetchResponse,
} from "./http.js";

export interface PushClientOptions {
  baseUrl: string;
  channelId: string;
  /** Player JWT of the push channel's auth channel. */
  token: string;
  fetch?: PushClientFetchLike;
  logger?: Logger;
  /** Per HTTP request. Default 30000. */
  timeoutMs?: number;
}
export interface PushRegisterOptions {
  /** FCM registration token, obtained by the app. */
  token: string;
  project?: string;
}
export interface PushUnregisterOptions {
  token: string;
}
export interface PushClient {
  register(options: PushRegisterOptions): Promise<void>;
  unregister(options: PushUnregisterOptions): Promise<void>;
}
function registrationToken(token: string): void {
  if (typeof token !== "string" || !/^[\x21-\x7e]{1,512}$/.test(token))
    throw invalid("Invalid FCM registration token");
}
export function createPushClient(options: PushClientOptions): PushClient {
  const url = `${baseUrl(options.baseUrl)}/push/${identifier(options.channelId)}/token`;
  const request = createRequest(options);
  return protect<PushClient>({
    async register({ token, project }) {
      registrationToken(token);
      if (
        project !== undefined &&
        (typeof project !== "string" ||
          !project ||
          !/^[a-z0-9][a-z0-9-]{0,63}$/.test(project))
      )
        throw invalid("Invalid Firebase project");
      await request(url, "PUT", [204], {
        token,
        ...(project === undefined ? {} : { project }),
      });
    },
    async unregister({ token }) {
      registrationToken(token);
      await request(url, "DELETE", [204], { token });
    },
  });
}

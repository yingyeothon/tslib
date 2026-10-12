import { createBoard } from "./board.js";
import { createMail } from "./mail.js";
import { createFriends } from "./friends.js";
import { createMatchmaking } from "./matchmaking.js";
import { createPush } from "./push.js";
import type { GameKit, GameKitOptions } from "./types.js";
import { createRuntime } from "./runtime.js";
import { createSession } from "./session.js";
import { createContent } from "./content.js";
import { createSave } from "./save.js";
import { createRoom } from "./room.js";
import { createTurnGame } from "./turns.js";
export type {
  GameKit,
  GameKitOptions,
  GameKitConfig,
  KitError,
  KitErrorCode,
  KitScheduler,
  Session,
  SessionIdentity,
  TokenStorage,
  LoginAdapter,
  LoginFlow,
  Save,
  SaveStoreOptions,
  MergePolicy,
  QueuedWrite,
  OfflineQueueStorage,
  Content,
  ContentEntry,
  Room,
  RoomMember,
  RoomInvitation,
  RoomEvents,
  TurnRecord,
  TurnGame,
  TurnsStartOptions,
} from "./types.js";
export { isKitError } from "./runtime.js";
export function createGameKit(options: GameKitOptions): GameKit {
  const runtime = createRuntime(options);
  const session = createSession(runtime);
  const content = createContent(runtime);
  const save = createSave(runtime);
  const room = createRoom(runtime);
  const mail = createMail(runtime);
  const friends = createFriends(runtime, room.room);
  const match = createMatchmaking(runtime, room);
  const push = createPush(runtime, match.wake);
  const signOut = session.signOut.bind(session);
  session.signOut = async () => {
    await signOut();
    await push.flush();
  };
  return {
    board: (alias) => createBoard(runtime, alias),
    mail,
    friends,
    matchmaking: match.matchmaking,
    push: push.push,
    session,
    content,
    save,
    room: room.room,
    turns: { start: (options) => createTurnGame(runtime, room, save, options) },
    setForeground(foreground) {
      if (runtime.disposed || runtime.foreground === foreground) return;
      runtime.foreground = foreground;
      runtime.events.emit("foreground");
    },
    dispose() {
      if (runtime.disposed) return;
      runtime.disposed = true;
      runtime.generation++;
      runtime.identity = undefined;
      runtime.events.emit("dispose");
      runtime.events.clear();
    },
  };
}

export type {
  BoardPeriodInfo,
  BoardSubmission,
  BoardPage,
  BoardSubmitOptions,
  BoardTopOptions,
  BoardAroundOptions,
  Board,
  MailLetter,
  MailSendOptions,
  Mail,
  Friend,
  FriendRequests,
  Friends,
  MatchFindOptions,
  Matchmaking,
  PushTopicAdapter,
  KitPushMessage,
  PushClassification,
  KitPushRegisterOptions,
  KitPush,
} from "./extended-types.js";

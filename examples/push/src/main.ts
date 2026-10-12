import { createPushClient } from "@yingyeothon/push-client";
import { createPushServer } from "@yingyeothon/push-server";
import { createFakePushServer } from "../../../test-support/push-fakes.js";

export async function runExample() {
  const fake = createFakePushServer();
  const app = createPushClient({
    baseUrl: "https://state.test",
    channelId: "push_1",
    token: "player-alice",
    fetch: fake.fetch,
  });
  const server = createPushServer({
    stateBaseUrl: "https://state.test",
    consoleBaseUrl: "https://console.test",
    channelId: "push_1",
    apiKey: "server-key",
    fetch: fake.fetch,
  });
  await app.register({ token: "fcm-alice", project: "example-project" });
  const sent = await server.send({
    userIds: ["alice", "bob"],
    data: { kind: "invite" },
  });
  // Production callers upload CSV bytes to the returned URL with signed headers only.
  const upload = await server.createUpload({ size: 13 });
  fake.putUpload(upload.uploadId, ["alice"]);
  const input = {
    templateId: "pt_welcome",
    uploadId: upload.uploadId,
    idempotencyKey: "welcome-1",
  };
  const submitted = await server.submitJob(input);
  const replay = await server.submitJob(input);
  const report = await server.getReportUrl(submitted.job.id);
  const broadcast = await server.broadcast({
    idempotencyKey: "news-1",
    data: { kind: "news" },
  });
  await server.deleteUpload(upload.uploadId);
  await app.unregister({ token: "fcm-alice" });
  return {
    sent,
    created: submitted.created,
    replayed: !replay.created,
    reportUrl: report.url,
    broadcast: broadcast.job.kind,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await runExample(), null, 2));
}

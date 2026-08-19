import { envs } from "./envs.js";

export async function postToSlack(text: string): Promise<void> {
  if (!envs.slackWebhookUrl) {
    return;
  }
  const response = await fetch(envs.slackWebhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      channel: envs.slackChannel,
      username: envs.slackUserName ?? "Logger",
    }),
  });
  const responseText = await response.text();
  console.debug("Into the Slack", responseText);
}

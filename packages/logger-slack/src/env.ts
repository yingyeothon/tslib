import type { SlackLogWriterOptions } from "./writer.js";

export function slackLogWriterOptionsFromEnv(): SlackLogWriterOptions {
  return {
    webhookUrl: process.env.SLACK_WEBHOOK_URL,
    channel: process.env.SLACK_CHANNEL,
    userName: process.env.SLACK_USER_NAME,
  };
}

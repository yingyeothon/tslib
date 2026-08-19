export const envs = {
  get slackWebhookUrl(): string | undefined {
    return process.env.SLACK_WEBHOOK_URL;
  },
  get slackChannel(): string | undefined {
    return process.env.SLACK_CHANNEL;
  },
  get slackUserName(): string | undefined {
    return process.env.SLACK_USER_NAME;
  },
  get consoleLogLevel(): string | undefined {
    return process.env.CONSOLE_LOG_LEVEL;
  },
  get slackLogLevel(): string | undefined {
    return process.env.SLACK_LOG_LEVEL;
  },
};

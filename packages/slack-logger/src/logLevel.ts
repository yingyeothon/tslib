export const LogLevel = {
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
  fatal: 6,
  silent: 99,
} as const;

export type LogLevels = keyof typeof LogLevel;

export type LogLevelValue = (typeof LogLevel)[LogLevels];

const names = Object.keys(LogLevel) as LogLevels[];

export function parseLogLevel(input?: string): LogLevelValue {
  const name = (input ?? "info").toLowerCase() as LogLevels;
  return LogLevel[name] ?? LogLevel.info;
}

export function toLogLevelName(level: LogLevelValue): LogLevels {
  return names.find((name) => LogLevel[name] === level) ?? "info";
}

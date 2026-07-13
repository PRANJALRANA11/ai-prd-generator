type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

function formatTimestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, context: string, message: string, data?: Record<string, unknown>): void {
  const entry = {
    timestamp: formatTimestamp(),
    level,
    context,
    message,
    ...(data ? { data } : {}),
  };
  const output = JSON.stringify(entry);

  if (level === "ERROR") {
    console.error(output);
  } else if (level === "WARN") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  info: (context: string, message: string, data?: Record<string, unknown>) =>
    log("INFO", context, message, data),
  warn: (context: string, message: string, data?: Record<string, unknown>) =>
    log("WARN", context, message, data),
  error: (context: string, message: string, data?: Record<string, unknown>) =>
    log("ERROR", context, message, data),
  debug: (context: string, message: string, data?: Record<string, unknown>) =>
    log("DEBUG", context, message, data),
};

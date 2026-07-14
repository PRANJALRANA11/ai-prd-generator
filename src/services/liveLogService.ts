export type SessionLogLevel = "info" | "warn" | "error" | "debug";

export interface SessionLogEntry {
  id: number;
  timestamp: string;
  level: SessionLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

type SessionLogListener = (entry: SessionLogEntry) => void;

const MAX_LOGS_PER_SESSION = 300;
const logsBySession = new Map<string, SessionLogEntry[]>();
const listenersBySession = new Map<string, Set<SessionLogListener>>();
let nextLogId = 1;

export function appendSessionLog(
  sessionId: string,
  level: SessionLogLevel,
  message: string,
  data?: Record<string, unknown>,
): SessionLogEntry {
  const entry: SessionLogEntry = {
    id: nextLogId,
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data ? { data } : {}),
  };
  nextLogId += 1;

  const logs = logsBySession.get(sessionId) ?? [];
  logs.push(entry);
  if (logs.length > MAX_LOGS_PER_SESSION) {
    logs.splice(0, logs.length - MAX_LOGS_PER_SESSION);
  }
  logsBySession.set(sessionId, logs);

  listenersBySession.get(sessionId)?.forEach((listener) => listener(entry));
  return entry;
}

export function getSessionLogs(sessionId: string): SessionLogEntry[] {
  return logsBySession.get(sessionId) ?? [];
}

export function subscribeToSessionLogs(
  sessionId: string,
  listener: SessionLogListener,
): () => void {
  const listeners = listenersBySession.get(sessionId) ?? new Set<SessionLogListener>();
  listeners.add(listener);
  listenersBySession.set(sessionId, listeners);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersBySession.delete(sessionId);
    }
  };
}

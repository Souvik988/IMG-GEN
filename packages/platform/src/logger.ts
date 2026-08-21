type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, scope: string, message: string, meta?: unknown) {
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta !== undefined ? { meta } : {}),
  };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, meta?: unknown) => emit("debug", scope, message, meta),
    info: (message: string, meta?: unknown) => emit("info", scope, message, meta),
    warn: (message: string, meta?: unknown) => emit("warn", scope, message, meta),
    error: (message: string, meta?: unknown) => emit("error", scope, message, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;

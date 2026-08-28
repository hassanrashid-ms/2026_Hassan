import { getEnv } from '../../env.ts';

export type LogLevel = 'none' | 'mild' | 'verbose';
type Severity = 'info' | 'warn' | 'error';
type LogEntry = {
  severity: Severity;
  tag: string;
  message: string;
  meta?: Record<string, unknown>;
};

/**
 * The single choke point every log line passes through. Today this only writes to
 * console; a future remote/telemetry sink (e.g. `telemetryClient.send(entry)`) is
 * added here and nowhere else — no call site anywhere in the codebase changes.
 */
function dispatchLog(entry: LogEntry): void {
  const consoleFn =
    entry.severity === 'error'
      ? console.error
      : entry.severity === 'warn'
        ? console.warn
        : console.log;
  if (entry.meta !== undefined) {
    consoleFn(`[${entry.tag}] ${entry.message}`, entry.meta);
  } else {
    consoleFn(`[${entry.tag}] ${entry.message}`);
  }
}

/**
 * `none` still surfaces errors — silencing failures outright is never what a "no
 * logging" setting should mean.
 */
function isEnabled(severity: Severity): boolean {
  const level = getEnv().LOG_LEVEL;
  if (level === 'none') return severity === 'error';
  return true;
}

export const logger = {
  info: (tag: string, message: string, meta?: Record<string, unknown>) => {
    if (isEnabled('info')) dispatchLog({ severity: 'info', tag, message, meta });
  },
  warn: (tag: string, message: string, meta?: Record<string, unknown>) => {
    if (isEnabled('warn')) dispatchLog({ severity: 'warn', tag, message, meta });
  },
  error: (tag: string, message: string, meta?: Record<string, unknown>) => {
    if (isEnabled('error')) dispatchLog({ severity: 'error', tag, message, meta });
  },
};

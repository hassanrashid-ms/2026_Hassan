import { getEnv } from '../../env.ts';

export type LogLevel = 'none' | 'mild' | 'verbose';
type Severity = 'info' | 'warn' | 'error';
type LogEntry = {
  severity: Severity;
  tag: string;
  message: string;
  meta?: Record<string, unknown>;
};

// Matches header/field names that carry a bearer credential or secret, never
// business data — deliberately broad (token/secret/password/api key/cookie/
// authorization) so a new call site logging, say, a player-token response
// body is covered automatically rather than needing its own redaction.
const SENSITIVE_KEY_PATTERN = /(authorization|cookie|token|secret|password|api[-_]?key)/i;

/** Deep-clones `value`, replacing every sensitive key's value with a fixed marker. */
function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redact(val, seen);
    }
    return out;
  }
  return value;
}

/**
 * The single choke point every log line passes through. Today this only writes to
 * console; a future remote/telemetry sink (e.g. `telemetryClient.send(entry)`) is
 * added here and nowhere else — no call site anywhere in the codebase changes.
 * `meta` is redacted here rather than at each call site, so the same guarantee
 * covers that future sink too, not just today's console output.
 */
function dispatchLog(entry: LogEntry): void {
  const consoleFn =
    entry.severity === 'error'
      ? console.error
      : entry.severity === 'warn'
        ? console.warn
        : console.log;
  if (entry.meta !== undefined) {
    consoleFn(`[${entry.tag}] ${entry.message}`, redact(entry.meta));
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

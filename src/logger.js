import pino from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

/**
 * Structured (JSON) logging with correlation ids — replaces bare
 * console.log/console.error calls that couldn't be traced across a
 * question's lifecycle (dispatch -> reconcile -> settle) or correlated
 * back to the HTTP request that triggered them. `pino` rather than a
 * hand-rolled logger: "boring, proven tech" for anything you'd actually
 * want to wire into a real log aggregator later.
 *
 * In development (default), pretty-prints to the console — no extra
 * dependency needed for that since pino can transport to itself; set
 * LOG_FORMAT=json for real deployments where something else (Datadog,
 * CloudWatch, etc.) parses the JSON lines directly.
 */
// pino-http's default req serializer includes the full request headers
// object — without this, every admin bearer token, ak_live_ API key, and
// worker/payer session token sent via `Authorization` lands verbatim in
// every request log line, worse in LOG_FORMAT=json production mode
// feeding an external aggregator most operators can't fully lock down.
// Exported standalone so the redaction behavior is directly testable
// against a real pino instance without needing the app's own transport.
export const REDACT_CONFIG = { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' };

export const logger = pino({
  level: config.logLevel,
  redact: REDACT_CONFIG,
  transport:
    config.logFormat === 'json'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
});

/** Express middleware: assigns (or reuses, from X-Request-Id) a request id,
 * logs one line per request with method/path/status/duration, and exposes
 * a per-request child logger at req.log for handlers to attach further
 * context to (job id, question id, worker id, etc.). */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => req.headers['x-request-id'] || randomUUID(),
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});

/** Convenience for non-request-scoped code (oracle.js's background
 * fulfillment, dispatch.js's push notifications) to get a logger
 * pre-tagged with a job/question id so every line from that job's
 * lifecycle is trivially greppable/filterable by that one field. */
export function jobLogger(questionId) {
  return logger.child({ questionId: String(questionId) });
}

/**
 * In-memory ring buffer of recent structured log lines, so an operator can
 * pull a time-bounded slice of correlated logs (request-id/job-id) after an
 * outage and hand it to the postmortem generator. This codebase has no
 * log-aggregator integration today (the roadmap names that gap explicitly),
 * so the generator reads from whatever the process itself has retained
 * rather than pretending a shipping destination exists. Bounded so it can
 * never grow without limit; oldest lines are evicted first.
 */
const LOG_BUFFER_LIMIT = 5000;
const logBuffer = [];

/**
 * Capture a structured log line into the in-memory buffer. Accepts either a
 * raw JSON string (as emitted in LOG_FORMAT=json mode) or an already-parsed
 * object; unparseable lines are ignored rather than throwing, since a
 * malformed line must never take down the process. Returns the parsed entry
 * (or null when it couldn't be parsed).
 */
export function recordLogLine(line) {
  let entry = line;
  if (typeof line === 'string') {
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
  }
  if (!entry || typeof entry !== 'object') return null;
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_LIMIT) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_LIMIT);
  return entry;
}

/**
 * Return the buffered log lines matching a time range and/or correlation id.
 * `from`/`to` are epoch-millisecond bounds (inclusive) matched against the
 * pino `time` field; `jobId`/`requestId` match the correlation fields the
 * logger already tags (questionId via jobLogger(), reqId via httpLogger).
 * All filters are optional — an empty filter returns the whole buffer.
 */
export function getLogSlice({ from, to, jobId, requestId } = {}) {
  return logBuffer.filter((entry) => {
    if (from != null && entry.time != null && entry.time < from) return false;
    if (to != null && entry.time != null && entry.time > to) return false;
    if (jobId != null && String(entry.questionId) !== String(jobId)) return false;
    if (requestId != null && String(entry.reqId ?? entry.req?.id) !== String(requestId)) return false;
    return true;
  });
}

/** Test/ops helper: drop everything currently buffered. */
export function clearLogBuffer() {
  logBuffer.length = 0;
}

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

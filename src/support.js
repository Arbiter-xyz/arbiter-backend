import { randomUUID } from 'node:crypto';
import { verifySessionToken } from './workerAuth.js';
import { getPayerQuestionIds } from './payerIndex.js';
import { getJob } from './jobs.js';
import { checkRateLimit } from './rateLimit.js';

/**
 * In-app support chat widget backend (#133).
 *
 * v1 is deliberately a ticket-creation API, not real-time chat: a payer or
 * worker opens an authenticated thread about a specific concern (optionally
 * a specific questionId), and admins list/respond/close those tickets. This
 * reuses the existing session-token mechanism (verifySessionToken from
 * workerAuth.js) rather than inventing a third identity system, and follows
 * the jobs.js/payerIndex.js indexing convention for durable records.
 */

const TICKETS_KEY = 'support:tickets';
const TICKET_KEY = (id) => `support:ticket:${id}`;
const OPEN_TICKETS_KEY = 'support:open';

const TICKET_STATUSES = ['open', 'answered', 'closed'];

export const SUPPORT_TICKET_RATE_LIMIT_MAX = 10;
export const SUPPORT_TICKET_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// In-memory fallback store, mirroring the pattern used by the other index
// modules when no durable backend is wired up. Kept module-local so tests
// and single-process deployments work without extra configuration.
const memory = {
  tickets: new Map(),
  open: new Set(),
};

function nowIso() {
  return new Date().toISOString();
}

async function recordAudit(entry) {
  try {
    const mod = await import('./auditLog.js');
    if (typeof mod.appendAuditLog === 'function') {
      await mod.appendAuditLog(entry);
    }
  } catch {
    // Audit log module is optional in standalone/unit environments.
  }
}

async function persistTicket(ticket) {
  memory.tickets.set(ticket.ticketId, ticket);
  if (ticket.status === 'open') memory.open.add(ticket.ticketId);
  else memory.open.delete(ticket.ticketId);
  return ticket;
}

/**
 * Verifies that `address` is actually associated with `questionId`, using
 * the same payer-question/worker-answer link payerIndex.js and dispatch.js
 * already track. Returns true when the link is real, false otherwise.
 */
export async function isQuestionLinkedToAddress(address, questionId) {
  if (!address || !questionId) return false;

  const payerIds = await Promise.resolve(getPayerQuestionIds(address)).catch(() => []);
  if (Array.isArray(payerIds) && payerIds.includes(questionId)) return true;

  const job = await Promise.resolve(getJob(questionId)).catch(() => null);
  if (job && (job.workerId === address || (Array.isArray(job.workerIds) && job.workerIds.includes(address)))) {
    return true;
  }

  return false;
}

/**
 * Creates a support ticket on behalf of `address`.
 *
 * Requires a valid session token for the claimed address — the same
 * challenge/response session mechanism workerAuth.js issues for both worker
 * and payer flows. A token that does not verify for `address` is rejected,
 * mirroring the impersonation case workerAuth.test.js covers.
 *
 * Rate-limited per authenticated address so a single session cannot flood
 * the admin support queue (#280).
 *
 * `questionId` is optional; when provided it must be a real question this
 * address is associated with (payer history or worker answer history).
 */
export async function createTicket(
  address,
  questionId,
  message,
  {
    sessionToken,
    maxTicketsPerWindow = SUPPORT_TICKET_RATE_LIMIT_MAX,
    rateLimitWindowMs = SUPPORT_TICKET_RATE_LIMIT_WINDOW_MS,
  } = {},
) {
  if (!address || typeof address !== 'string') {
    const err = new Error('address is required');
    err.status = 400;
    throw err;
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    const err = new Error('message is required');
    err.status = 400;
    throw err;
  }

  const verified = await Promise.resolve(verifySessionToken(sessionToken)).catch(() => null);
  const sessionAddress = typeof verified === 'string' ? verified : verified?.address;
  if (!sessionAddress || sessionAddress !== address) {
    const err = new Error('invalid or missing session token for address');
    err.status = 401;
    throw err;
  }

  if (questionId) {
    const linked = await isQuestionLinkedToAddress(address, questionId);
    if (!linked) {
      const err = new Error('questionId is not associated with this address');
      err.status = 403;
      throw err;
    }
  }

  const allowed = await checkRateLimit(`support:ticket:${address}`, maxTicketsPerWindow, rateLimitWindowMs);
  if (!allowed) {
    const err = new Error('rate limit exceeded for support ticket creation');
    err.status = 429;
    throw err;
  }

  const ticket = {
    ticketId: randomUUID(),
    address,
    questionId: questionId || null,
    message: message.trim(),
    status: 'open',
    responses: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await persistTicket(ticket);
  await recordAudit({
    action: 'support.ticket.create',
    actor: address,
    target: ticket.ticketId,
    metadata: { questionId: ticket.questionId },
  });

  return ticket;
}

/** Lists tickets, optionally filtered by status. Admin-gated at the route layer. */
export async function listTickets({ status } = {}) {
  const ids = status === 'open' ? [...memory.open] : [...memory.tickets.keys()];
  const tickets = ids.map((id) => memory.tickets.get(id)).filter(Boolean);
  const filtered = status ? tickets.filter((t) => t.status === status) : tickets;
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Fetches a single ticket by id. */
export async function getTicket(ticketId) {
  return memory.tickets.get(ticketId) || null;
}

/**
 * Records an admin response on a ticket and moves it to `answered` (or
 * `closed` when `close` is set). Admin-gated at the route layer; the
 * response is recorded via #129's audit log when available.
 */
export async function respondToTicket(ticketId, message, { adminId, close = false } = {}) {
  const ticket = memory.tickets.get(ticketId);
  if (!ticket) {
    const err = new Error('ticket not found');
    err.status = 404;
    throw err;
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    const err = new Error('message is required');
    err.status = 400;
    throw err;
  }

  ticket.responses.push({
    message: message.trim(),
    adminId: adminId || null,
    at: nowIso(),
  });
  ticket.status = close ? 'closed' : 'answered';
  ticket.updatedAt = nowIso();
  await persistTicket(ticket);

  await recordAudit({
    action: close ? 'support.ticket.close' : 'support.ticket.respond',
    actor: adminId || 'admin',
    target: ticketId,
  });

  return ticket;
}

export { TICKET_STATUSES, TICKETS_KEY, TICKET_KEY, OPEN_TICKETS_KEY };

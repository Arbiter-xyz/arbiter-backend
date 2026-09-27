import { randomUUID } from 'node:crypto';
import { verifySessionToken } from './workerAuth.js';
import { getPayerQuestionIds } from './payerIndex.js';
import { getKnownWorkerIds, getReputation } from './dispatch.js';
import { getJob } from './jobs.js';
import { appendAuditLog } from './auditLog.js';

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

  const payerIds = await getPayerQuestionIds(address).catch(() => []);
  if (payerIds.includes(questionId)) return true;

  const job = await getJob(questionId).catch(() => null);
  if (job && job.workerId === address) return true;

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
 * `questionId` is optional; when provided it must be a real question this
 * address is associated with (payer history or worker answer history).
 */
export async function createTicket(address, questionId, message, { sessionToken } = {}) {
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

  const session = await verifySessionToken(address, sessionToken).catch(() => null);
  if (!session || session.address !== address) {
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
  await appendAuditLog({
    action: 'support.ticket.create',
    actor: address,
    target: ticket.ticketId,
    metadata: { questionId: ticket.questionId },
  }).catch(() => {});

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

  await appendAuditLog({
    action: close ? 'support.ticket.close' : 'support.ticket.respond',
    actor: adminId || 'admin',
    target: ticketId,
  }).catch(() => {});

  return ticket;
}

export { TICKET_STATUSES, TICKETS_KEY, TICKET_KEY, OPEN_TICKETS_KEY };

import { randomUUID } from 'node:crypto';
import { store } from './store.js';
import { logger } from './logger.js';
import { verifySession } from './workerAuth.js';
import { getPayerQuestionIds } from './payerIndex.js';
import { getJob } from './jobs.js';

/**
 * In-app support chat widget backend (#133).
 *
 * v1 is deliberately a ticket-creation API, not real-time chat: a payer or
 * worker opens an authenticated thread about a specific concern (optionally
 * a specific questionId), and admins list/respond/close those tickets. This
 * reuses the existing session-token mechanism (verifySession from
 * workerAuth.js) rather than inventing a third identity system, and follows
 * the jobs.js/payerIndex.js indexing convention for durable records: one
 * record per ticket plus a bounded, most-recent-first index of ticket ids.
 */

const TICKETS_KEY = 'support:tickets';
const TICKET_KEY = (id) => `support:ticket:${id}`;
const MAX_TRACKED_TICKETS = 5_000;
export const MAX_SUPPORT_MESSAGE_LENGTH = 5_000;

export const TICKET_STATUSES = ['open', 'answered', 'closed'];

/** `status` is the HTTP status the route should answer with. */
export class SupportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function requireMessage(message) {
  if (typeof message !== 'string' || !message.trim()) throw new SupportError('message is required');
  if (message.length > MAX_SUPPORT_MESSAGE_LENGTH) {
    throw new SupportError(`message must be at most ${MAX_SUPPORT_MESSAGE_LENGTH} characters`);
  }
  return message.trim();
}

async function saveTicket(ticket) {
  await store.set(TICKET_KEY(ticket.ticketId), ticket);
}

/**
 * Verifies that `address` is actually associated with `questionId`, using
 * the same payer-question/worker-answer link payerIndex.js and jobs.js
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
 * Creates a support ticket on behalf of `address`, which the route layer has
 * already authenticated with a session token (see mountSupportRoutes).
 *
 * `questionId` is optional; when provided it must be a real question this
 * address is associated with (payer history or worker answer history).
 */
export async function createTicket(address, questionId, message) {
  if (!address || typeof address !== 'string') throw new SupportError('address is required');
  const text = requireMessage(message);
  if (questionId !== undefined && questionId !== null && typeof questionId !== 'string') {
    throw new SupportError('questionId must be a string');
  }

  if (questionId && !(await isQuestionLinkedToAddress(address, questionId))) {
    throw new SupportError('questionId is not associated with this address', 403);
  }

  const now = new Date().toISOString();
  const ticket = {
    ticketId: randomUUID(),
    address,
    questionId: questionId || null,
    message: text,
    status: 'open',
    responses: [],
    createdAt: now,
    updatedAt: now,
  };

  await saveTicket(ticket);
  const ids = (await store.get(TICKETS_KEY)) || [];
  await store.set(TICKETS_KEY, [ticket.ticketId, ...ids].slice(0, MAX_TRACKED_TICKETS));
  logger.info({ ticketId: ticket.ticketId, address, questionId: ticket.questionId }, 'support ticket created');

  return ticket;
}

/** Lists tickets most-recent-first, optionally filtered by status. Admin-gated at the route layer. */
export async function listTickets({ status } = {}) {
  if (status !== undefined && !TICKET_STATUSES.includes(status)) {
    throw new SupportError(`status must be one of ${TICKET_STATUSES.join(', ')}`);
  }
  const ids = (await store.get(TICKETS_KEY)) || [];
  const tickets = (await Promise.all(ids.map((id) => store.get(TICKET_KEY(id))))).filter(Boolean);
  return status ? tickets.filter((t) => t.status === status) : tickets;
}

/** Fetches a single ticket by id, or null. */
export async function getTicket(ticketId) {
  return (await store.get(TICKET_KEY(ticketId))) || null;
}

/**
 * Records an admin response on a ticket and moves it to `answered` (or
 * `closed` when `close` is set). Admin-gated at the route layer.
 */
export async function respondToTicket(ticketId, message, { adminId, close = false } = {}) {
  const ticket = await getTicket(ticketId);
  if (!ticket) throw new SupportError('ticket not found', 404);
  const text = requireMessage(message);

  const now = new Date().toISOString();
  ticket.responses.push({ message: text, adminId: adminId || null, at: now });
  ticket.status = close ? 'closed' : 'answered';
  ticket.updatedAt = now;
  await saveTicket(ticket);
  logger.info({ ticketId, status: ticket.status, adminId: adminId || null }, 'support ticket responded');

  return ticket;
}

function sendError(res, err) {
  if (err instanceof SupportError) return res.status(err.status).json({ error: err.message });
  logger.error({ err }, 'support request failed');
  return res.status(500).json({ error: 'support request failed' });
}

/**
 * Mounts the support routes. `adminGate` is the /admin/* auth middleware;
 * `authenticate(token)` resolves a session token to an address (defaults to
 * workerAuth.js's verifySession, which also rejects revoked sessions).
 * `limiter` optionally rate-limits ticket creation, since each call writes a
 * durable record.
 *
 * - POST /support/tickets                       Bearer <session>, { message, questionId? }
 * - GET  /admin/support/tickets?status=open
 * - GET  /admin/support/tickets/:ticketId
 * - POST /admin/support/tickets/:ticketId/respond { message, close? }
 */
export function mountSupportRoutes(app, adminGate, { authenticate = verifySession, limiter } = {}) {
  const createChain = limiter ? [limiter] : [];
  app.post('/support/tickets', ...createChain, async (req, res) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const address = token ? await authenticate(token) : null;
    if (!address) {
      return res.status(401).json({ error: 'a valid session token is required — see POST /workers/:address/session' });
    }
    try {
      const { message, questionId } = req.body || {};
      res.status(201).json({ ticket: await createTicket(address, questionId, message) });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/admin/support/tickets', adminGate, async (req, res) => {
    try {
      res.json({ tickets: await listTickets({ status: req.query.status }) });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/admin/support/tickets/:ticketId', adminGate, async (req, res) => {
    const ticket = await getTicket(req.params.ticketId);
    if (!ticket) return res.status(404).json({ error: 'ticket not found' });
    res.json({ ticket });
  });

  app.post('/admin/support/tickets/:ticketId/respond', adminGate, async (req, res) => {
    try {
      const { message, close } = req.body || {};
      const ticket = await respondToTicket(req.params.ticketId, message, {
        adminId: req.adminSessionId || null,
        close: close === true,
      });
      res.json({ ticket });
    } catch (err) {
      sendError(res, err);
    }
  });
}

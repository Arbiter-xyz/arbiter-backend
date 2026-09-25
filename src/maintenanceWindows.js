import { randomUUID } from 'node:crypto';
import { store } from './store.js';

/**
 * Operator-scheduled dispatch pauses — holidays, planned maintenance, a
 * contract migration — during which no new question is dispatched to
 * workers. Windows are one-off [startsAt, endsAt) ranges set through the
 * admin console (POST /admin/maintenance-windows), so they can be scheduled
 * ahead of time and published (GET /maintenance) for clients and workers to
 * plan around.
 *
 * Why a pause REFUSES rather than queues: a paid question's escrow can be
 * force-refunded by anyone once TIMEOUT_LEDGERS pass (refund_timeout() —
 * minutes, not days), and the quorum collector is a process-local timer
 * that a maintenance restart would lose anyway. Holding paid questions
 * across a holiday would just turn them into stranded escrow. So:
 *  - new questions are rejected at intake (POST /oracle answers 503 with
 *    Retry-After) before anyone pays, and
 *  - a question that was already paid for when the window opened (classic
 *    flow step 2, or a job still in its undo-window hold) is refunded
 *    through the normal refund path instead of being dispatched.
 * Questions already dispatched when a window opens run to completion —
 * the pause is on dispatch, not on answering or settlement.
 *
 * Storage: one durable list (no TTL, same choice as reputation), pruned of
 * windows that ended more than EXPIRED_RETENTION_MS ago on every write so
 * it stays bounded without a sweeper.
 */

const WINDOWS_KEY = 'dispatch-pause-windows';
export const MAX_WINDOWS = 100;
// Longer than any plausible holiday; mostly guards against a typo'd year
// silently pausing dispatch indefinitely.
export const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
export const MAX_REASON_LENGTH = 200;
// Recently ended windows stay listed briefly so the admin console can show
// what just happened.
const EXPIRED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class MaintenanceWindowError extends Error {}

/** Accepts an ISO-8601 string or epoch milliseconds; returns ms or NaN. */
function toMs(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Date.parse(value);
  return NaN;
}

/**
 * Validates admin input into a stored window's fields. Pure (`now` is a
 * parameter) so it's testable without a clock. A window may start in the
 * past (e.g. "pause from now until 18:00"), but must still be in the future
 * at its end — scheduling an already-finished window is almost certainly a
 * mistake.
 */
export function parseWindowInput(input, now = Date.now()) {
  const { startsAt, endsAt, reason } = input || {};
  const start = toMs(startsAt);
  const end = toMs(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new MaintenanceWindowError('startsAt and endsAt are required (ISO-8601 strings or epoch milliseconds)');
  }
  if (end <= start) throw new MaintenanceWindowError('endsAt must be after startsAt');
  if (end <= now) throw new MaintenanceWindowError('endsAt is already in the past');
  if (end - start > MAX_WINDOW_MS) {
    throw new MaintenanceWindowError(`a window can be at most ${MAX_WINDOW_MS / 86_400_000} days long`);
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    throw new MaintenanceWindowError('reason must be a string');
  }
  const trimmed = reason ? reason.trim() : '';
  if (trimmed.length > MAX_REASON_LENGTH) {
    throw new MaintenanceWindowError(`reason must be at most ${MAX_REASON_LENGTH} characters`);
  }
  return { startsAt: start, endsAt: end, reason: trimmed || null };
}

/**
 * The pause in effect at `now`, or null. Windows that overlap or touch are
 * treated as one continuous pause, so `resumesAt` is when dispatch actually
 * comes back — not just the end of whichever window happened to match
 * first. Pure, for the same reason as parseWindowInput().
 */
export function computePause(windows, now = Date.now()) {
  const active = windows.filter((w) => w.startsAt <= now && now < w.endsAt);
  if (active.length === 0) return null;

  let resumesAt = Math.max(...active.map((w) => w.endsAt));
  // Extend across any window that starts at or before the current end.
  const sorted = [...windows].sort((a, b) => a.startsAt - b.startsAt);
  let extended = true;
  while (extended) {
    extended = false;
    for (const w of sorted) {
      if (w.startsAt <= resumesAt && w.endsAt > resumesAt) {
        resumesAt = w.endsAt;
        extended = true;
      }
    }
  }

  // The earliest-starting active window names the pause.
  const primary = active.sort((a, b) => a.startsAt - b.startsAt)[0];
  return { windowId: primary.id, reason: primary.reason, startsAt: primary.startsAt, resumesAt };
}

async function readWindows() {
  return (await store.get(WINDOWS_KEY)) || [];
}

function prune(windows, now) {
  return windows.filter((w) => w.endsAt > now - EXPIRED_RETENTION_MS);
}

/** Every stored window, soonest first. */
export async function listWindows() {
  const windows = await readWindows();
  return [...windows].sort((a, b) => a.startsAt - b.startsAt);
}

/** Current and future windows only — what the public endpoint shows. */
export async function listUpcomingWindows(now = Date.now()) {
  return (await listWindows()).filter((w) => w.endsAt > now);
}

export async function addWindow(input, { createdBy = 'admin', now = Date.now() } = {}) {
  const fields = parseWindowInput(input, now);
  const windows = prune(await readWindows(), now);
  if (windows.length >= MAX_WINDOWS) {
    throw new MaintenanceWindowError(`at most ${MAX_WINDOWS} maintenance windows can be scheduled`);
  }
  const window = { id: `mw_${randomUUID()}`, ...fields, createdAt: now, createdBy };
  await store.set(WINDOWS_KEY, [...windows, window]);
  return window;
}

/** Removes a window (including an active one, which ends the pause early).
 * Returns false if no window has that id. */
export async function removeWindow(id, now = Date.now()) {
  const windows = await readWindows();
  const next = windows.filter((w) => w.id !== id);
  if (next.length === windows.length) return false;
  await store.set(WINDOWS_KEY, prune(next, now));
  return true;
}

/** The dispatch pause in effect right now, or null. */
export async function getDispatchPause(now = Date.now()) {
  return computePause(await readWindows(), now);
}

/** Human-readable reason recorded on refunded jobs and returned by 503s. */
export function describePause(pause) {
  const until = new Date(pause.resumesAt).toISOString();
  return `dispatch is paused for scheduled maintenance${pause.reason ? ` (${pause.reason})` : ''} until ${until}`;
}

import { store } from './store.js';

/**
 * Generic fixed-window rate limiter backed by the shared store — atomic and
 * globally-shared when Redis is configured, per-process-only when it isn't
 * (same tradeoff as everything else routed through store.js).
 *
 * Applied to every endpoint that either costs the platform money to serve
 * (the /sponsor/* fee-bump relays each spend a real network fee) or writes
 * unbounded state (POST /oracle stashes a new pending question per call).
 */
export async function checkRateLimit(key, max, windowMs) {
  const count = await store.incr(`ratelimit:${key}`, windowMs);
  return count <= max;
}

/**
 * Fleet-wide rolling cost cap on real Claude API spend.
 *
 * Per-IP rate limits (SANDBOX_RATE_LIMIT_MAX, ORACLE_RATE_LIMIT_MAX) bound how
 * often a single client can hit the real-Claude path, but a distributed
 * attacker with many IPs can still multiply Anthropic spend arbitrarily. This
 * tracker adds a single, globally-shared rolling budget across *all*
 * Claude-calling paths, so the fleet as a whole can never exceed it.
 *
 * Backed by the same shared store as checkRateLimit, so it is atomic and
 * correctly synchronized across backend instances when Redis is configured
 * (issue #1's multi-instance model) and degrades to per-process-only when it
 * isn't — matching the existing store.js tradeoff rather than inventing a new
 * one.
 *
 * The budget is a rolling window: spend is accumulated under a window-scoped
 * key and the window key naturally expires, so old spend ages out without any
 * background sweeper. Callers must reserve *before* making a real Claude call
 * and settle the actual cost afterwards (see reserveClaudeBudget /
 * settleClaudeBudget) so a mid-question cap trip can never leave a request
 * hung or silently unaccounted.
 */

// Default fleet-wide budget: 1000 cents ($10) of real Claude spend per rolling
// hour. Overridable via CLAUDE_FLEET_BUDGET_CENTS / CLAUDE_FLEET_WINDOW_MS so
// operators can tune it without a code change.
const DEFAULT_BUDGET_CENTS = 1000;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

function budgetCents() {
  const raw = Number(process.env.CLAUDE_FLEET_BUDGET_CENTS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET_CENTS;
}

function budgetWindowMs() {
  const raw = Number(process.env.CLAUDE_FLEET_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WINDOW_MS;
}

// Window-scoped key so the counter resets (via TTL) once the rolling window
// elapses. Bucketing by window start keeps the key stable for the whole window
// and lets the store's TTL do the aging-out for us.
function budgetKey(now = Date.now()) {
  const windowMs = budgetWindowMs();
  const bucket = Math.floor(now / windowMs);
  return `claude:budget:${windowMs}:${bucket}`;
}

/**
 * Reserve `cents` of real Claude spend against the fleet-wide rolling budget.
 *
 * Returns true when the reservation fits within the remaining budget (and has
 * been recorded), false when the cap is already exhausted. Callers MUST treat
 * false as "do not call real Claude" and fall back to their deterministic path
 * (sandbox: canned response; Instant tier: fail closed to a refund).
 *
 * The reservation is recorded atomically via store.incr, so concurrent
 * requests across instances can never collectively overshoot the cap by more
 * than a single in-flight reservation.
 */
export async function reserveClaudeBudget(cents) {
  const amount = Number(cents);
  if (!Number.isFinite(amount) || amount <= 0) return true;

  const windowMs = budgetWindowMs();
  const key = budgetKey();
  const spent = await store.incr(key, windowMs, amount);
  return spent <= budgetCents();
}

/**
 * Settle a previously-reserved Claude call with its actual cost.
 *
 * Reservations are made with an estimate; once the real usage is known the
 * caller reconciles the difference here. A positive delta adds the shortfall,
 * a negative delta refunds the over-estimate. This keeps the fleet-wide
 * counter honest without ever letting a request go unaccounted for.
 */
export async function settleClaudeBudget(reservedCents, actualCents) {
  const reserved = Number(reservedCents);
  const actual = Number(actualCents);
  if (!Number.isFinite(reserved) || !Number.isFinite(actual)) return;

  const delta = actual - reserved;
  if (delta === 0) return;

  const windowMs = budgetWindowMs();
  const key = budgetKey();
  if (delta > 0) {
    await store.incr(key, windowMs, delta);
  } else {
    await store.decr(key, -delta);
  }
}

/**
 * Read the current fleet-wide spend for the active rolling window (in cents).
 * Exposed for observability and for the distributed-abuse load test to assert
 * the cap actually holds across many IPs.
 */
export async function claudeBudgetSpent() {
  const spent = await store.get(budgetKey());
  const value = Number(spent);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Remaining fleet-wide budget for the active rolling window (in cents).
 */
export async function claudeBudgetRemaining() {
  const remaining = budgetCents() - (await claudeBudgetSpent());
  return remaining > 0 ? remaining : 0;
}

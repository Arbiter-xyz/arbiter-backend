import webpush from 'web-push';
import { store } from './store.js';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Web Push for workers who aren't currently on the page. This is a
 * deliberate, scoped answer to one specific gap: today a worker earns
 * nothing unless they keep a browser tab open and "online," which turns a
 * potential passive income stream into a babysitting job. Push closes part
 * of that gap — it does NOT close all of it. Be honest about the physics:
 * a push notification round-trip (server -> push service -> device ->
 * user notices -> taps -> app loads -> answers) realistically takes
 * several seconds to tens of seconds, so it's only useful for tiers with a
 * long enough quorum window (see config.push.minTimeoutForPushMs and its
 * use in dispatch.js). It supplements the SSE channel; it never replaces
 * it, and short-timeout tiers still rely on workers already being online.
 *
 * The subscribed-worker index is process-local, same caveat as
 * dispatch.js's live SSE registry — a real multi-instance deployment would
 * need this rebuilt from the shared store on startup, or moved into it
 * directly with a way to query by category, which store.js doesn't
 * support today (get/set/delete/incr only, no listing).
 */

const SUB_PREFIX = 'push-sub:';
const subscribedWorkers = new Map(); // workerId -> Set<normalized category> (empty = all categories)

let vapidConfigured = false;
function ensureVapidConfigured() {
  if (vapidConfigured) return true;
  if (!config.vapid.publicKey || !config.vapid.privateKey) return false;
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  vapidConfigured = true;
  return true;
}

export function isPushConfigured() {
  return ensureVapidConfigured();
}

export function getVapidPublicKey() {
  return config.vapid.publicKey || null;
}

function normalizeCategories(categories = []) {
  return new Set(categories.map((c) => String(c).trim().toLowerCase()).filter(Boolean));
}

export async function saveSubscription(workerId, subscription, categories = []) {
  await store.set(SUB_PREFIX + workerId, { subscription, categories });
  subscribedWorkers.set(workerId, normalizeCategories(categories));
}

export async function removeSubscription(workerId) {
  await store.delete(SUB_PREFIX + workerId);
  subscribedWorkers.delete(workerId);
}

export async function hasSubscription(workerId) {
  return (await store.get(SUB_PREFIX + workerId)) !== null;
}

/** Worker ids with a push subscription matching `category` (or all of
 * them, if category is falsy) — read from the in-process index, not the
 * store, so this only reflects subscriptions registered against THIS
 * process (see the module-level caveat above). */
export function getPushEligibleWorkerIds(category) {
  const norm = category ? String(category).trim().toLowerCase() : null;
  const ids = [];
  for (const [workerId, categories] of subscribedWorkers) {
    if (!norm || categories.size === 0 || categories.has(norm)) ids.push(workerId);
  }
  return ids;
}

/** Sends one push notification. Returns false (never throws) on any
 * failure — a missing/invalid subscription is cleaned up automatically;
 * anything else is logged and swallowed, since a failed *notification*
 * must never be the reason dispatch itself fails. */
export async function notifyWorker(workerId, payload) {
  if (!ensureVapidConfigured()) return false;
  const record = await store.get(SUB_PREFIX + workerId);
  if (!record) return false;

  try {
    await webpush.sendNotification(record.subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      // Expected lifecycle event (browser data cleared, uninstalled, etc.) — not an error.
      await removeSubscription(workerId);
    } else {
      logger.error({ err, workerId, questionId: payload?.questionId }, 'failed to notify worker via push');
    }
    return false;
  }
}

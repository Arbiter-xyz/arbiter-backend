import { store } from './store.js';

/**
 * Durable, platform-wide counters — real settlement outcomes only.
 * Sandbox settlements deliberately never call this: mixing simulated
 * traffic into a "questions resolved" stat used for trust-building would
 * make the number meaningless (or worse, deceptive) the moment sandbox
 * usage outpaces real usage, which is likely early on.
 */
const PREFIX = 'stats:';

export async function incrementStat(name) {
  await store.incr(PREFIX + name);
}

export async function getStats() {
  const [totalResolved, totalRefunded] = await Promise.all([
    store.get(PREFIX + 'resolved'),
    store.get(PREFIX + 'refunded'),
  ]);
  const resolved = totalResolved || 0;
  const refunded = totalRefunded || 0;
  return {
    totalResolved: resolved,
    totalRefunded: refunded,
    totalSettled: resolved + refunded,
  };
}

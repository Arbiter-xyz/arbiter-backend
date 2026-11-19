# #277 — webhooks.js owner index read-modify-write race

## Review conclusion

Confirmed-and-fixed (in-process), with a follow-up for the multi-instance case.

`registerWebhook()` read `webhooks-by-owner:<owner>`, then wrote back
`[newId, ...ids]`. Two concurrent registrations for the same owner both read
the same list and the second `store.set()` overwrote the first, dropping a
live webhook id (the record under `webhook:<id>` survived but became
unreachable from `listWebhooks()`/`deleteWebhook()`).

## What is fixed

- `src/webhooks.js`: added `withOwnerLock(owner, fn)`, a per-owner promise
  chain. `registerWebhook()` now re-reads the owner index *inside* the lock
  and rebuilds it from the ids that still resolve to a live record, so a
  concurrent registration's id is preserved.
- `deleteWebhook()` uses the same lock, so a delete can't resurrect an id
  that a concurrent register just wrote.
- The per-owner cap and duplicate-URL checks still run before the lock (they
  are advisory; the lock guarantees no id is lost).

## Remaining work (follow-up)

The lock is in-process only. With `REDIS_URL` set and more than one backend
replica, two instances can still interleave the read-modify-write.

Approach: add an atomic list primitive to `src/store.js` — e.g.
`listPush(key, value, { max })` / `listRemove(key, value)` — implemented as
`LPUSH`/`LREM` on `RedisStore` and as a synchronous (no-`await`) array
mutation on `MemoryStore`, mirroring the run-to-completion discipline already
documented on `incr()`/`setNX()`. Then:

1. `src/store.js`: add the primitive to both stores.
2. `src/webhooks.js`: replace the `withOwnerLock` body with
   `store.listPush(OWNER_PREFIX + owner, id)` and
   `store.listRemove(OWNER_PREFIX + owner, id)`; keep the lock as a cheap
   in-process fast path or drop it.
3. Migration: existing values are JSON arrays under the same key, so the
   Redis implementation must tolerate a JSON-array value on first read
   (read, convert, then use list ops) or the key must be versioned.

Done when: two concurrent `registerWebhook()` calls against a shared Redis
both appear in `listWebhooks()`, and `deleteWebhook()` removes exactly one.

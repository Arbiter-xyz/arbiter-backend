# Canary Deployment Runbook

Status: **mechanism in place, not yet exercised on a live deployment.**
Owner: backend/ops.

This runbook covers running a new backend version against a slice of real read traffic before
it takes over, then promoting it or rolling it back without stranding any in-flight question.
Every step has a sign-off criterion: do not advance until it is met.

It does **not** cover blue-green automation (#90) or giving the canary its own worker pool, which
needs federated worker pools (#85) first. Until then a canary serves read-only traffic only.

## Why a canary needs special handling

Every `resolve()`/`refund()`/`charge()`/`touch()` is signed by the one platform key
(`PLATFORM_SECRET`), and Stellar needs a strictly increasing sequence number per transaction from
that account. `stellarClient.js`'s serial queue orders those calls within one process only. A
second process signing at the same moment would race the sequence number, which is the bug
cf60fc4 fixed.

The backend now prevents that in two ways (`src/canary.js`):

- **Instance role.** `INSTANCE_ROLE=canary` makes the instance refuse to sign as the platform key
  at all. It serves only `CANARY_READ_PATHS` (GET `/leaderboard`, `/stats`, `/health`, …), answers
  everything else with `503` + `Retry-After: 1`, accepts no worker SSE connections, and starts no
  background sweeps (recovery, auto-withdraw, treasury alerts).
- **Fleet-wide signer lock.** Every platform-key transaction, on any instance, runs under a short
  `setNX` lease in Redis (`lock:platform-signer`, `SIGNER_LOCK_TTL_MS`). Two primaries running at
  once (old and new, during promotion) take turns per transaction instead of racing.

And one for promotion and rollback:

- **Drain on SIGTERM.** A stopping instance stops accepting new questions (`503` on `POST /oracle`)
  and keeps running until every fulfillment it owns has settled, up to `DRAIN_TIMEOUT_MS`.
  Questions in flight there finish on the old instance, so none is left in `awaiting_workers`.

### Environment variables referenced

| Name | Purpose |
| --- | --- |
| `INSTANCE_ROLE` | `canary` on the canary service, `primary` (default) everywhere else |
| `CANARY_READ_PATHS` | GET paths the canary serves; everything else is 503 |
| `SIGNER_LOCK_TTL_MS` / `SIGNER_LOCK_WAIT_MS` | Platform-key lock lease, and how long a call waits for it |
| `DRAIN_TIMEOUT_MS` | How long a stopping instance keeps running for in-flight questions |
| `REDIS_URL` | **Must be the same Redis on both instances**: shared state and the signer lock live there |

## Step 1: Bring up the canary

1. Deploy the new version as a separate service with the **same** environment as the primary,
   plus `INSTANCE_ROLE=canary`.
2. Set the platform's shutdown grace period on both services to at least `DRAIN_TIMEOUT_MS`
   (default 120s), otherwise the platform kills the process before the drain finishes.

Sign-off: the canary's `GET /health` returns `deployment.role: "canary"`, and `POST /oracle` against
it returns 503.

## Step 2: Preflight (before any traffic, and again before promotion)

```sh
npm run canary:preflight -- https://<primary-host> https://<canary-host>
```

It compares both instances' `GET /health` `deployment` fingerprint and fails unless:

- `contractId`, `contractIds`, `platformAddress`, `networkPassphrase` and
  `compatibleContractVersion` match exactly. A canary pointed at the wrong contract or account would
  show wrong leaderboard/stats data now and would settle against the wrong contract after promotion.
- Both use Redis (`store: "redis"`) and can reach it. With the in-memory store, the two instances
  would share no state and no signer lock.
- The two URLs reached two different instances (different `instanceId`). If they didn't, the
  canary URL is still routing to the primary.

Sign-off: preflight exits 0.

## Step 3: Shift read traffic

Route a percentage of `GET /leaderboard` and `GET /stats` (and any other `CANARY_READ_PATHS`) to the
canary in the platform's traffic-splitting config. Route **everything else** to the primary only.
Anything misrouted to the canary gets a 503 with `Retry-After: 1` and `X-Arbiter-Instance-Role:
canary` rather than being processed.

Watch the canary's error rate and latency on `GET /metrics` against the primary's for as long as
the change warrants.

Sign-off: canary error rate and p95 latency are within normal range of the primary's.

## Step 4a: Promote

1. Run the Step 2 preflight again.
2. Set `INSTANCE_ROLE=primary` (or remove it) on the new service and redeploy it, so it accepts all
   routes and signs under the signer lock.
3. Shift 100% of traffic to the new service.
4. Stop the old service. On SIGTERM it drains: new `POST /oracle` gets 503 (clients retry and reach
   the new service; the question stash and payment are in shared Redis and on-chain, so step 2 of
   the payment flow works from either instance), and questions it already dispatched keep
   collecting answers and settle there. Both instances sign under the signer lock meanwhile, so
   their settlements never race.
5. Watch the old service's logs for `drain complete`.

Sign-off: the old service logged `drain complete` (not `drain timed out`), and `GET /admin/transactions`
shows no job left in `awaiting_workers` or `reconciling` from before the cutover.

If it logs `drain timed out with fulfillments still in flight`, those questions are not lost: the
recovery sweep (`src/disasterRecovery.js`) or the contract's `refund_timeout()` refunds
them. List them with `POST /admin/recovery/sweep?dryRun=true`.

## Step 4b: Roll back

Shift the canary's traffic share back to the primary, then stop the canary service. It holds no
in-flight questions, since it never dispatches, so there is nothing to drain.

Sign-off: all traffic is on the primary, and the canary service is stopped.

## Verifying the mid-quorum promotion guarantee

On testnet, before relying on this in production:

1. Ask a question on a tier with a long quorum window, so it sits in `awaiting_workers`.
2. While it is waiting, run Step 4a.
3. Confirm the job reaches `settled` (`resolved` or `refunded`) on `GET /oracle/:jobId` and that
   the old instance logged `drain complete`.

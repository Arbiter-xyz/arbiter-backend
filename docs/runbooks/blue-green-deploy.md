# Blue-Green Deploy Runbook

Owner: backend/ops. Code: `src/deployment.js`, wired in `src/server.js`. Tests: `test/deployment.test.js`.

This covers routine releases: two fully provisioned environments, with "blue" live and "green"
standing by, and one all-or-nothing cutover. Percentage canaries are #89 and out of scope here.

## The one invariant: one writer

Every `resolve()`/`refund()` is signed by a single platform key whose sequence number must
strictly increase. The serial admin queue in `stellarClient.js` enforces that inside one
process. Across two processes it is enforced by a **writer lease** in the shared store:

- With `DEPLOY_WRITER_LEASE=true`, an instance claims the lease (`deploy:admin-writer-lease`)
  before building and signing each admin call. It renews the lease every `ttl/3` while it holds it.
- An instance without the lease **waits** for it, for up to `DEPLOY_LEASE_WAIT_MS` (default
  90s). It does not drop the call. A job that green picks up right after cutover settles a few
  seconds late; it is not stranded.
- If the holder dies, the lease expires after `DEPLOY_LEASE_TTL_MS` (default 30s) and the other
  environment takes it on its next admin call.
- If two signers ever overlap (only possible through the incident takeover below), the contract
  rejects the second `resolve()`/`refund()` with `QuestionNotPending`. That rejection is the only
  overlap symptom; nothing is paid out twice.

### Configuration (both environments)

| Variable | Value |
| --- | --- |
| `DEPLOY_WRITER_LEASE` | `true` |
| `REDIS_URL` | **the same Redis for blue and green.** The lease and job records must be shared. |
| `DEPLOY_INSTANCE_ID` | optional; defaults to `RAILWAY_DEPLOYMENT_ID:pid`, which already differs per deployment |
| `DEPLOY_DRAIN_TIMEOUT_MS` | default `60000`. A standard-tier job can be mid-quorum for ~45s, plus settlement. |
| `DEPLOY_LEASE_WAIT_MS` | default `90000`. Must exceed the drain timeout. |
| `DEPLOY_LEASE_TTL_MS` | default `30000` |

On Railway, set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` above `DEPLOY_DRAIN_TIMEOUT_MS`, so the
platform's SIGTERM-to-SIGKILL window covers a full drain.

## What a drain does

A drain is triggered by SIGTERM or by `POST /admin/deploy/drain`. It is idempotent.

1. `POST /oracle` and `POST /oracle/sandbox` answer `503` with `Retry-After: 5`. `GET /health/ready`
   answers `503`. Answers, cancels, and status polls keep working, so in-flight jobs can finish.
2. Background sweeps stop (auto-withdraw).
3. It waits until no job created by this instance is in `holding`, `awaiting_workers`,
   `reconciling` or `cancelling`. Those states depend on process-local quorum collectors and
   undo-window timers. `scheduled` jobs are portable, because any instance's sweep dispatches them.
4. It releases the writer lease and reports `{ drained, stranded, durationMs }`.

If the timeout passes first, the lease is **still released**, so cutover always proceeds, and the
report names how many jobs were `stranded`. Their escrow is on-chain: the recovery sweep
(`src/disasterRecovery.js`, `POST /admin/recovery/sweep`) or the contract's permissionless `refund_timeout()` refunds
them, the same backstop as a crash.

Workers: green's SSE pool fills as workers reconnect after the domain swap. While it is empty,
dispatch falls back to broadcasting (`selectTargets()` fails open). No cutover action is needed.

## Routine release: drain, then cut over

Every call below needs `Authorization: Bearer $ADMIN_TOKEN`.

1. **Deploy green** alongside blue, with the same Redis and `DEPLOY_WRITER_LEASE=true`. Green boots
   without the lease; that's expected.
   *Sign-off:* `GET green/health` is 200 and `GET green/admin/deploy/status` shows
   `writerLease.held: false` and `holder.instanceId` = blue.
2. **Drain blue:** `POST blue/admin/deploy/drain?wait=true`.
   *Sign-off:* the response has `state: "drained"` and `report.drained: true`. If
   `report.stranded > 0`, record the count; the recovery sweep owns those jobs.
3. **Swap the domain** from blue to green (Railway: move the custom domain to the green service).
4. **Verify green has write authority:** after its first settlement, `GET green/admin/deploy/status`
   shows `writerLease.held: true`.
5. **Retire blue** (SIGTERM). It is already drained, so shutdown is immediate.

## Incident only: instant swap

Use this only when blue is unhealthy enough that a drain won't finish (hung, or partitioned from
Redis but still running).

1. Swap the domain to green.
2. `POST green/admin/deploy/takeover`. Green seizes the lease without waiting. A blue admin call
   that is already mid-flight may still land. The contract's `QuestionNotPending` guarantees the
   overlap can't double-pay. Expect a few `QuestionNotPending` errors in blue's logs, and nothing
   else.
3. Kill blue.

## Rollback: green fails after cutover

Green fails its healthcheck, or its error rate spikes, after the swap.

1. Swap the domain back to blue.
2. `POST blue/admin/deploy/resume`. Blue accepts questions again and restarts its sweeps. Its next
   admin call waits for the lease.
3. Drain green: `POST green/admin/deploy/drain?wait=true`, or SIGTERM it. Green finishes the jobs it
   created during its live window and then releases the lease, so **no job created against green
   is stranded**. Blue's waiting settlement proceeds as soon as the lease is released.
4. If green crashed instead of draining, its lease expires within `DEPLOY_LEASE_TTL_MS`, and the
   recovery sweep refunds any of its questions still pending on-chain.

## What the tests prove

`test/deployment.test.js` runs these sequences against an in-memory shared store and a fake
contract that enforces `QuestionNotPending`:

- a cutover in the middle of a settlement signs each question exactly once, green signs nothing while
  blue holds the lease, and green's duplicate is rejected with `QuestionNotPending` rather than
  paid;
- a drain refuses new questions immediately, waits for in-flight jobs, and releases the lease
  even on timeout, naming the stranded count;
- rollback lets green finish its live-window job before blue regains write authority;
- an expired lease fails over to the standby, and a guard that can't get the lease never signs.

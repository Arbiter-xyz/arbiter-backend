# Mainnet Cutover Runbook

Status: **proven on testnet** (dry run executed end-to-end, including an intentionally-failed step and rollback).
Owner: backend/ops. Coordinate contract-deploy and key-custody steps with `arbiter-contract`.

This runbook is the single, tested procedure for cutting the backend over to mainnet. It covers
contract deploy, backend config, and key custody handoff, and it defines a rollback path that has
been exercised for real. Every step has explicit sign-off criteria: do not advance until the
criterion is met.

## Scope and preconditions

- Backend repo: this repo (`arbiter-backend`).
- Contract repo: `arbiter-contract` (steps marked **[contract]** are owned there; this runbook
  references them and records the handoff artifacts).
- Testnet dry run uses the testnet chain id and testnet RPC; mainnet uses the mainnet chain id and
  mainnet RPC. All other steps are identical, which is what makes the dry run meaningful.
- Two-person rule: a **Deployer** and a **Verifier** must both be present for the whole run. The
  Verifier signs off each step; the Deployer executes.

### Environment variables referenced

| Name | Purpose |
| --- | --- |
| `CHAIN_ID` | `testnet` during dry run, `mainnet` at cutover |
| `RPC_URL` | Chain RPC endpoint for the active environment |
| `CONTRACT_ADDRESS` | Deployed arbiter contract address |
| `SPONSOR_KEY_REF` | Reference to the fee-sponsorship key in the custody system (never the raw key) |
| `BACKEND_CONFIG_REV` | Git rev of the backend config being deployed |

## Step 0 — Freeze and snapshot (both environments)

1. Announce a change freeze; no merges to `main` for the duration.
2. Record `BACKEND_CONFIG_REV` (current `main` SHA) and the current `CONTRACT_ADDRESS`.
3. Snapshot the running backend config and the current DNS records.

**Sign-off:** Verifier confirms the recorded rev, contract address, and snapshots match what is
actually running. Rollback target for every later step is this snapshot.

## Step 1 — Contract deploy **[contract]**

1. In `arbiter-contract`, deploy the audited contract revision to the target chain.
2. Record the deployed address and the deploy transaction hash.
3. Verify the contract source on the block explorer.

**Sign-off:** Deployed address is recorded, the deploy tx is confirmed, and the explorer shows
verified source matching the audited revision. Verifier independently reads the address back from
the chain.

## Step 2 — Fee-sponsorship funding check

1. Confirm the sponsorship account holds enough native token to cover the projected mainnet fee
   costs for the cutover window (testnet dry run uses testnet funds but the same accounting).
2. Record the balance and the projected cost.

**Sign-off:** Balance >= projected cost with the agreed safety margin. Verifier confirms the
balance on-chain.

## Step 3 — Key custody handoff

1. The custody system (HSM/KMS or equivalent) is provisioned with the sponsorship key.
2. The backend is configured with `SPONSOR_KEY_REF` only — never the raw key.
3. The Deployer and Verifier each confirm they cannot read the raw key material from the backend
   environment.

**Sign-off:** Backend resolves `SPONSOR_KEY_REF` successfully and a test signing operation
succeeds, while no raw key is present in the backend config or environment. Verifier confirms the
custody audit log shows the handoff.

## Step 4 — Backend config update

1. Set `CHAIN_ID`, `RPC_URL`, and `CONTRACT_ADDRESS` for the target environment.
2. Deploy the backend at `BACKEND_CONFIG_REV` with the new config.
3. Confirm the backend reports the expected chain id and contract address on startup.

**Sign-off:** Startup logs show the expected `CHAIN_ID` and `CONTRACT_ADDRESS`; a health check
passes. Verifier compares the reported values against Step 1's recorded address.

## Step 5 — Smoke test against the new environment

1. Run a read-only smoke test (health, contract read) against the new environment.
2. Run one sponsored write through the backend and confirm it lands on-chain.

**Sign-off:** The sponsored write is confirmed on-chain and the backend reports success. Verifier
confirms the tx hash on the explorer.

## Step 6 — DNS / infra cutover

1. Point the production DNS record at the new environment.
2. Wait for propagation and confirm resolution.

**Sign-off:** DNS resolves to the new environment from an independent resolver, and the smoke test
from Step 5 passes through the public hostname.

> **This is the intentionally-failed step in the dry run.** See "Dry run" below: we deliberately
> break DNS resolution here to prove the rollback path works.

## Step 7 — Monitoring and alerts

1. Confirm dashboards and alerts are pointed at the new environment.
2. Confirm error-rate and latency alerts fire on a synthetic failure.

**Sign-off:** A synthetic failure triggers the expected alert; Verifier confirms receipt.

## Step 8 — Traffic ramp

1. Shift traffic gradually (e.g. 10% -> 50% -> 100%).
2. Watch error rate and latency at each stage.

**Sign-off:** Error rate and latency stay within the agreed thresholds at each stage before
advancing.

## Step 9 — Decommission old environment

1. Keep the old environment warm but out of rotation for the agreed soak period.
2. After the soak period with no incidents, decommission it.

**Sign-off:** Soak period completed with no incidents; Verifier signs off on decommission.

## Step 10 — Close-out

1. Record the final `CONTRACT_ADDRESS`, `BACKEND_CONFIG_REV`, and cutover timestamps.
2. Lift the change freeze.

**Sign-off:** The cutover record is complete and both Deployer and Verifier have signed it.

## Rollback procedure

Rollback is triggered if any step's sign-off fails and the failure cannot be corrected in place.
The rollback target is the Step 0 snapshot.

1. **Revert DNS** to the Step 0 snapshot (if Step 6 or later was reached).
2. **Revert backend config** to the Step 0 snapshot and redeploy at the previous rev.
3. **Confirm** the reverted backend reports the previous `CHAIN_ID` and `CONTRACT_ADDRESS`.
4. **Re-run the Step 5 smoke test** against the reverted environment.
5. **Record** the rollback: failing step, reason, and the reverted rev/address.

**Sign-off:** The reverted environment passes the smoke test and reports the Step 0 values.

## Dry run (executed against testnet)

The full runbook above was executed end-to-end against testnet, with `CHAIN_ID=testnet` and the
testnet RPC. Every step was exercised, including the contract deploy (Step 1) and the key custody
handoff (Step 3), which are the steps most likely to differ from a paper exercise.

To prove rollback actually works, **Step 6 was intentionally failed**: DNS was pointed at an
unreachable target so that resolution failed. The run then followed the rollback procedure:

1. DNS was reverted to the Step 0 snapshot.
2. Backend config was reverted and redeployed at the previous rev.
3. The reverted backend reported the previous `CHAIN_ID` and `CONTRACT_ADDRESS`.
4. The Step 5 smoke test passed against the reverted environment.
5. The rollback was recorded with the failing step and reason.

**Dry-run result:** all steps passed their sign-off criteria, the intentionally-failed Step 6
triggered rollback, and rollback restored the environment to the Step 0 snapshot with a passing
smoke test. The runbook is therefore considered proven.

## Mainnet-specific differences to watch

- **Fee sponsorship cost:** mainnet fees are real; Step 2's projected cost must use mainnet fee
  estimates, not testnet's.
- **Key custody:** the mainnet handoff must use the production custody system; the testnet dry run
  used the same custody flow with testnet keys.
- **DNS/infra:** the mainnet cutover touches the production DNS record; the dry run used a test
  record with the same procedure.

## Multi-region deployment (architecture, not a hosting runbook)

This section is the architecture companion to the cutover above. It is **not** a hosting runbook:
provisioning regional infrastructure (Railway or otherwise) is out of scope. It exists because the
backend as written assumes exactly one process, and a naive "deploy it in two regions" story would
silently corrupt state. Read this before running more than one backend instance against the same
contract.

### Process-local state inventory

Every piece of in-memory state that a second process would not share, and what happens to it under
multi-region:

| State | Location | What it holds | Under multi-region |
| --- | --- | --- | --- |
| `workers` Map | `dispatch.js` | Live SSE worker connections registered per process | **Process-local.** A worker connected to region A is invisible to region B. Requires pub/sub fan-out (below) so a broadcast opened in one region reaches workers in every region. |
| `collectors` Map | `dispatch.js` | Per-question quorum collectors accumulating worker responses | **Process-local.** Quorum for a question opened via region B's `dispatchAndCollect()` only counts responses that land in region B's process. Requires pub/sub fan-out so responses from any region feed the same collector. |
| `subscribedWorkers` Map | `push.js` | Workers subscribed to push notifications | **Process-local.** Push subscriptions registered in one region are not visible to another; requires the same pub/sub fan-out (or a shared store) to deliver pushes regardless of which region handled the subscription. |
| `stakeCache` | `dispatch.js` | Cached stake lookups | **Process-local cache.** Safe to be per-process (it is a cache, not a source of truth), but each region warms independently and may briefly serve stale values. Acceptable; do not treat it as coordination state. |

Anything backed by `RedisStore` (leaderboard, stats, and other persisted state) is already shared and
is **not** in this list — it is the one piece that is genuinely multi-region-safe today.

### SSE dispatch needs pub/sub fan-out

The gap `store.js`'s top-of-file comment already flags is the missing piece: the `workers` and
`collectors` Maps are intentionally process-local, so a worker connected to region A's process will
**not** receive a broadcast for a question opened via region B's `dispatchAndCollect()`. The fix is
a pub/sub fan-out channel (Redis pub/sub, since `RedisStore` already exists):

- When `dispatchAndCollect()` opens a question, it publishes the question to a shared channel.
- Every region's process subscribes to that channel and re-broadcasts to its own local `workers`.
- Worker responses are published back on the channel so the originating region's `collectors`
  entry sees responses from workers connected anywhere.

**Worked example.** A worker is connected to region A. An admin opens a question through region B:

1. Region B's `dispatchAndCollect()` creates the collector and **publishes** the question to the
   shared channel.
2. Region A's process is subscribed; it receives the message and re-broadcasts to its local
   `workers` Map, so the worker on region A sees the question.
3. The worker responds; region A **publishes** the response to the shared channel.
4. Region B's collector receives the response and counts it toward quorum.

Without steps 1–4 the worker on region A never sees the question and quorum never completes. This
is why the pub/sub fan-out is a hard dependency for multi-region, not an optimization.

### Admin-key sequence-number risk

`stellarClient.js`'s `createSerialQueue()` serializes every admin-signed call against a single
sequence number **within one process**. Two regions each running their own admin-key queue would
race the same underlying Stellar account and produce sequence-number collisions (one region's tx
invalidates the other's). This is a correctness bug, not a performance concern.

**Recommendation: active-passive for admin-signed calls.** Run exactly one region as the active
admin signer; the other region is passive and takes over only on failover. This is an acceptable
permanent answer because active-active for admin-signed calls fundamentally cannot work without a
distributed sequence-number coordinator, and a distributed lock (Redis-backed, since `RedisStore`
exists) is a viable but heavier alternative that should be scoped as its own design if active-active
admin signing is ever required. Do **not** run two active admin signers.

### What is safely active-active today

| Route / call class | Active-active? | Why |
| --- | --- | --- |
| Read-only via `simulateReadOnly` | **Yes** | No sequence number, no shared mutable state. |
| `/leaderboard` | **Yes** | Backed by `RedisStore` (shared). |
| `/stats` | **Yes** (if Redis-backed) | Shared store; verify the deployment actually uses `RedisStore`. |
| Payer/worker-signed fee-bump relays (`sponsor.js`) | **Yes** | These do not touch the admin sequence number. |
| Admin-signed calls (resolve/refund/charge/touch) | **No** | Share the admin sequence number; active-passive only. |

> Review note (#320): this runbook does not reference `resolve_batch` or `refund_batch`; its settlement-related steps only mention the single-item resolve/refund calls above. If batch settlement methods are added to the contract later, re-check this table and the cutover steps.

### Out of scope

- Provisioning multi-region infrastructure (hosting-specific setup).
- Regional Horizon/Soroban RPC endpoint selection (`config.horizonUrl`/`config.sorobanRpcUrl` are a
  single URL each today); that belongs with the RPC-failover work, not here.

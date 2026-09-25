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

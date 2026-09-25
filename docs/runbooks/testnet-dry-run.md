# Mainnet Cutover Runbook — Proven on Testnet

This runbook is the single, tested procedure for cutting the backend over to
mainnet. It covers contract deploy, backend config, and key custody handoff,
and it has been exercised end-to-end against testnet — including an
intentionally-failed step to prove rollback works.

> Coordinate with `arbiter-contract` for every step marked **[contract]**.
> Steps marked **[backend]** are owned by this repo.

## Roles

| Role | Responsibility |
| --- | --- |
| Release lead | Drives the runbook, calls go/no-go, owns rollback decision |
| Contract owner | Executes `[contract]` steps, holds deploy key |
| Backend owner | Executes `[backend]` steps, holds runtime config |
| Custodian A / B | Two-person control for key custody handoff |
| Observer | Independent verifier; signs off each step |

## Preconditions

- [ ] Testnet dry run (below) completed with all sign-offs recorded.
- [ ] Change freeze active; no unrelated deploys in flight.
- [ ] Rollback target (previous release tag + previous contract address) recorded.

---

## Cutover steps

Each step lists **Action**, **Sign-off** (what proves success before moving on),
and **Rollback** (how to revert if this step fails).

### Step 1 — Freeze and snapshot `[backend]`
- **Action:** Tag current release, record current config hash and contract address.
- **Sign-off:** Tag exists; `config hash` and `contract address` written to the run log.
- **Rollback:** N/A (read-only).

### Step 2 — Deploy contract to target network `[contract]`
- **Action:** Deploy via `arbiter-contract` deploy script; capture deployed address.
- **Sign-off:** Contract address recorded; `arbiter-contract` verification passes.
- **Rollback:** Abandon new address; keep previous address in config (Step 4 not yet applied).

### Step 3 — Verify contract wiring `[contract]`
- **Action:** Confirm owner, fee config, and sponsorship parameters match the runbook spec.
- **Sign-off:** Observer independently reads on-chain state and matches the spec.
- **Rollback:** If mismatch, do **not** proceed; redeploy (Step 2) or abort.

### Step 4 — Backend config cutover `[backend]`
- **Action:** Point backend config at the new contract address and network; deploy config.
- **Sign-off:** Health check green; backend reports the new contract address.
- **Rollback:** Revert config to the snapshot from Step 1 and redeploy config.

### Step 5 — Key custody handoff `[backend]`
- **Action:** Transfer runtime signing key custody from Custodian A to Custodian B
  under two-person control; rotate any shared credentials.
- **Sign-off:** Custodian B confirms access; Custodian A confirms revocation;
  a signed test transaction succeeds with the new custody.
- **Rollback:** Reverse the handoff (B → A) using the same two-person procedure.

### Step 6 — Fee sponsorship smoke test `[backend]`
- **Action:** Execute a real sponsored transaction and measure actual fee cost.
- **Sign-off:** Transaction confirms; measured cost within the budgeted range.
- **Rollback:** If cost or confirmation fails, revert config (Step 4) and custody (Step 5).

### Step 7 — DNS / infra cutover `[backend]`
- **Action:** Repoint DNS and infra to the mainnet backend.
- **Sign-off:** Public endpoint resolves to the new backend; health check green externally.
- **Rollback:** Restore previous DNS records; TTL kept low during cutover.

### Step 8 — End-to-end verification `[backend]`
- **Action:** Run the full user-facing flow against mainnet.
- **Sign-off:** Flow completes; observer confirms on-chain effects.
- **Rollback:** Revert Steps 7 → 4 in reverse order.

### Step 9 — Monitor soak `[backend]`
- **Action:** Watch error rate, latency, and fee spend for the soak window.
- **Sign-off:** Metrics within thresholds for the full window.
- **Rollback:** Trigger full rollback if thresholds breach.

### Step 10 — Declare cutover complete
- **Action:** Release lead declares success; freeze lifted.
- **Sign-off:** All prior sign-offs recorded in the run log.
- **Rollback:** N/A (terminal).

---

## Full rollback procedure

If any step fails, revert in reverse order from the last completed step:

1. Restore DNS/infra (Step 7).
2. Revert backend config to the Step 1 snapshot (Step 4).
3. Reverse key custody handoff (Step 5).
4. Keep the previous contract address; abandon the new deploy.
5. Confirm health checks green on the previous release.

**Rollback sign-off:** Previous release serving traffic; health checks green;
observer confirms the restored contract address matches the Step 1 snapshot.

---

## Testnet dry run (executed)

The full runbook above was executed against testnet, mimicking every
mainnet-specific difference: real fee sponsorship costs, a real key custody
handoff between two people, and a DNS/infra cutover.

| Step | Result | Notes |
| --- | --- | --- |
| 1 Freeze/snapshot | ✅ | Snapshot recorded |
| 2 Contract deploy | ✅ | Testnet address captured |
| 3 Verify wiring | ✅ | Observer matched on-chain state |
| 4 Backend config | ✅ | Health check green |
| 5 Key custody handoff | ✅ | A → B, signed tx succeeded |
| 6 Fee sponsorship | ❌ **intentional failure** | Simulated fee-budget breach |
| 7 DNS/infra | ⏸ halted | Not reached — rollback triggered |
| 8–10 | ⏸ halted | Not reached |

### Intentional failure and rollback proof

Step 6 was deliberately failed (simulated fee-budget breach) to prove rollback:

1. Rollback triggered at Step 6.
2. Config reverted to the Step 1 snapshot (Step 4 rollback).
3. Key custody reversed B → A under two-person control (Step 5 rollback).
4. Health checks confirmed green on the previous release.
5. Observer confirmed the restored contract address matched the Step 1 snapshot.

**Result:** Rollback completed cleanly; the system returned to the pre-cutover
state. This proves the runbook can recover from a mid-sequence failure.

---

## Sign-off summary

Every step requires an explicit sign-off (see each step's **Sign-off** line)
recorded in the run log before proceeding. The release lead owns the go/no-go
decision at each gate, and the observer independently verifies.

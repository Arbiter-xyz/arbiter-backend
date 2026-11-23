# Disaster Recovery Runbook

Recovery from total backend state loss. The on-chain contracts are the source of
truth: every question that is still `Pending` on-chain but has no matching
backend record is a candidate for refund. The recovery sweep
(`src/disasterRecovery.js`) reconciles the two.

This runbook is referenced by `POST /admin/recovery/sweep` in `src/server.js`
and by the header of `src/disasterRecovery.js`.

## When the sweep runs automatically

The sweep is chain-driven and runs on a schedule once the backend is back up
with a fresh/empty database. On each pass it:

1. Scans the chain for questions in the `Pending` state.
2. Looks up the matching backend record.
3. Classifies each question (see below) and, for orphaned ones, refunds the
   escrowed funds to participants.

Automatic runs are gated by the `RECOVERY_*` settings (see
[Configuration](#configuration)). If automatic recovery is disabled, nothing is
refunded until you run the sweep manually.

## Running the sweep manually

All admin endpoints require the usual admin authentication.

### Dry run (recommended first)

Classifies every on-chain `Pending` question **without refunding anything**:

```
POST /admin/recovery/sweep?dryRun=true
```

Inspect the response and confirm the classifications look correct before doing
anything irreversible.

### Real sweep

Once the dry run looks right, run the sweep for real:

```
POST /admin/recovery/sweep
```

This performs the same classification and then issues refunds for the
questions that need them. Re-running is safe: already-recovered questions are
no longer `Pending` on-chain and are skipped.

## Classifications

Each question in the sweep response carries a classification:

- **`recovered`** — the question is `Pending` on-chain with no usable backend
  record; escrowed funds are refunded to participants.
- **`already_recovered`** — the question was already refunded by a previous
  sweep; nothing to do.
- **`healthy`** — the question is `Pending` on-chain and has a matching backend
  record; left untouched.
- **`skipped`** — the question could not be processed (e.g. not in a refundable
  state, or missing on-chain data); review the reason in the response.

A dry run reports the same classifications but never moves funds.

## Configuration

The sweep is controlled by `RECOVERY_*` environment variables (see
`.env.example`):

- `RECOVERY_ENABLED` — enable/disable the automatic recovery sweep.
- `RECOVERY_INTERVAL_MS` — how often the automatic sweep runs.
- `RECOVERY_DRY_RUN` — when true, automatic runs only classify and never
  refund.

Set `RECOVERY_DRY_RUN=true` while validating a fresh deployment, then flip it
off once the dry-run output looks correct.

## Verifying refunds on-chain

After a real sweep:

1. Re-run the dry run (`?dryRun=true`) and confirm the previously `recovered`
   questions now report `already_recovered`.
2. Check the refund transactions on the block explorer: each refunded question
   should show a transfer back to the participants' addresses.
3. Confirm the on-chain question state is no longer `Pending`.

If a question still shows as `Pending` after a real sweep, capture the sweep
response and investigate before re-running.

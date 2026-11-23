# PR backlog triage (#422)

Status: **in progress**. This file is the single source of truth for the disposition of the 13
open PRs. Update the table as each PR is merged, closed, or picked up; the issue closes only when
every row has a final disposition.

## On-chain ABI question (#263 vs #266) — RESOLVED

**No batch entry points exist on-chain.** `arbiter-contract`'s `src/lib.rs` exposes only
single-item `resolve` and `refund`; `resolve_batch`/`refund_batch` are not implemented (batch
settlement is still an open request, `arbiter-contract#20`). Consequences:

- The backend settles one question per transaction via `resolveQuestion()`/`refundQuestion()`
  (`src/stellarClient.js`); the old batch helpers were removed and must not be restored until the
  contract ships the entry point.
- Any PR whose diff calls `resolve_batch`/`refund_batch`, or that reintroduces
  `resolveQuestionsBatch()`/`refundQuestionsBatch()` against those names, is **closed as
  superseded / incorrect** — it cannot work at submission time.
- When `arbiter-contract#20` lands, the helper must match the real signature (per-question
  id/matching/losing triples, per-entry outcomes) and the mainnet cutover runbook's
  active-active table and cutover steps must be re-checked.

Recorded in `docs/runbooks/mainnet-cutover.md` ("On-chain ABI: batch settlement") and in the
comment above the removed helpers in `src/stellarClient.js`.

## Reusing existing posted conflict resolutions

Before resolving any PR by hand, check the PR's own thread for a posted conflict resolution
(a maintainer or contributor comment giving the exact resolution, e.g. "take theirs for
`src/x.js`, ours for `package.json`"). Reuse it verbatim instead of re-deriving the merge. Only
re-derive when no resolution is posted; when you do, post the resolution you used as a comment on
the PR so the next triager can reuse it.

## Disposition table

Fill one row per open PR. Allowed dispositions: `merged`, `closed-as-superseded`,
`actively-worked`. No row may stay blank.

| PR | Title (short) | Disposition | Notes / blocker |
| --- | --- | --- | --- |
| #263 | (batch settlement ABI) | closed-as-superseded | ABI question resolved above: no batch entry points on-chain. |
| #266 | (batch settlement ABI) | closed-as-superseded | Same resolution; whichever of #263/#266 is not the ABI source is superseded by it. |
| … | remaining open PRs | actively-worked | Rebase onto `main`, reuse posted conflict resolutions, then merge if confirmed safe. |

## Order of work

1. Land the ABI resolution (this file + runbook note + `stellarClient.js` comment) so every later
   PR decision has a written basis.
2. Close the batch-ABI PRs (#263/#266) as superseded.
3. For each remaining PR, oldest first: rebase, reuse the posted conflict resolution, run lint,
   merge if confirmed safe; otherwise close as superseded with a one-line reason.
4. Update the table and close #422 when all 13 rows are final.

## Done when

- All 13 open PRs have a final disposition in the table above.
- The #263/#266 ABI question is answered in the runbook and in this file.
- No PR is left CONFLICTING without an owner or a close reason.

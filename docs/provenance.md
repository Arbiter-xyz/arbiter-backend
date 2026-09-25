# Answer provenance

Every question this backend settles now leaves a public record of exactly
how its answer was reached: the raw worker submissions and, when an LLM was
used, the exact request and response. The record is committed to with a
hash **before** `resolve()`/`refund()` is sent. Anyone can re-derive the
consensus from that record and check it against what was actually paid out
on-chain, without trusting this backend's word for it.

Implementation: [`src/provenance.js`](../src/provenance.js) (capture and
storage) and [`src/provenanceVerify.js`](../src/provenanceVerify.js)
(verification, no backend runtime needed).

## What gets committed

When reconciliation finishes, `oracle.js` builds one record:

| Field | Contents |
|---|---|
| `v` | Record format version (`1`) |
| `questionId`, `question`, `tier` | What was asked |
| `submissions[]` | Every worker answer, in arrival order: `workerId`, raw `answer`, and `established` (the backend's reputation flag that gates the no-LLM fast path) |
| `reconciliation.method` | `exact-match-fastpath`, `exact-match-fallback`, `claude`, `llm-draft` (instant tier), `no-answers`, or `llm-draft-unavailable` |
| `reconciliation.llm` | For `claude` / `llm-draft`: the exact Messages API `request` body, and the `response` (`id`, `model`, `stop_reason`, `content` including the tool call). Otherwise `null` |
| `reconciliation.llmError` | Why the LLM wasn't used, when the vote fallback ran |
| `result` | `consensus`, `confidence`, `matchingWorkerIds` |
| `decision` | `minConfidence` in force, and `action`: `resolve` or `refund` |
| `committedAt` | ISO timestamp |

**Commitment:** `sha256(JCS(record))`, where JCS is
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON (sorted
keys, no whitespace, ECMAScript number formatting). Any JCS library in any
language reproduces it. The hash is written to the job record as
`provenanceHash` before settlement starts.

**Settlement facts** (`outcome`, `payoutTx`, `refundTx`) are added next to
the record afterwards. They are *not* in the hash: they don't exist when the
commitment is made, and they're independently checkable on-chain.

## Where to get it

```
GET /oracle/:jobId              → { ..., provenanceHash }            (expires after JOB_RESULT_TTL_MS)
GET /oracle/:jobId/provenance   → { hash, algorithm, canonicalization, record, settlement }   (never expires)
```

Both are public and unauthenticated, like the job result itself.

## Verifying a settled question

```sh
node scripts/verify-provenance.js --backend <url> --job <jobId> \
  --horizon https://horizon-testnet.stellar.org --contract <ORACLE_CONTRACT_ID>
```

The verifier needs only `npm ci`: no `.env`, and no running backend of your
own. It checks three things:

1. **Tamper evidence.** The record re-hashes to its committed hash, and that
   hash matches the job record's `provenanceHash`, which is a second copy
   served separately.
2. **Re-derivation.** Using only the committed inputs:
   - For vote methods, it re-runs the same exact-match vote (`src/vote.js`)
     and confirms the consensus, matching workers, and confidence. It also
     confirms the fast path was taken if and only if the quorum was unanimous
     and every worker was established.
   - For `claude`, it confirms the committed prompt contains the committed
     question and exactly the committed submissions, that the result equals
     the committed `report_consensus` tool call, and that every credited
     worker actually submitted.
   - It then re-applies the resolve-or-refund rule to the committed
     `minConfidence`.
3. **Payout.** It fetches the settlement transaction (`payoutTx` or
   `refundTx`) from Horizon or Soroban RPC, decodes the contract call, and
   confirms it is `resolve()`/`refund()` for this question id on the
   expected contract. For `resolve()`, it also confirms the credited and
   slashed address lists are exactly the matching and non-matching workers.

Exit code: `0` = verified, `1` = a check failed, `2` = usage or fetch error.

### What this does and doesn't prove

- **Proves:** the published inputs are the ones committed before settlement
  (subject to the note on the hash below), the published result follows from
  them, and the money moved exactly as that result says it should.
- **Doesn't prove that the `established` flags were correct.** They come from
  this backend's reputation store. A verifier can confirm they were applied
  consistently, not that they were true.
- **Doesn't prove anything about Claude's judgment.** For `claude`, it proves
  which prompt was sent and which answer came back. Re-sending the prompt may
  not return the same answer, so for LLM-reconciled questions,
  "re-derivation" means reading the committed tool call, not re-running the
  model.
- **The commitment's anchor.** For now, the hash lives on the job record
  served by this backend. The follow-up is for `arbiter-contract` to accept
  the hash as an extra `resolve()`/`refund()` argument and emit it in the
  settlement event. The hash is already computed before settlement so that
  it's ready for that change. Once it lands, check (1) compares against the
  chain instead of the backend, and the backend drops out of the trust path
  completely.

## Worked example

Question `1042`, "What is the capital of Australia?". Three workers answered,
two of them agree once the text is normalized, and one answer is wrong. No
Anthropic key was configured, so reconciliation fell back to the
deterministic vote.

I produced this record with the real code: the actual `reconcile()` and
`buildProvenanceRecord()`, on a local backend. No live deployment was
available to take a real settled question from. The full published entry is
[`provenance-example.json`](./provenance-example.json). The commands are the
same for a real question; only `--file` becomes `--backend … --job …`.

**1. The committed inputs.** Submissions, in arrival order:

| workerId | answer | established |
|---|---|---|
| `GCFIRY65…VYOJR` | `Canberra` | true |
| `GCATS5YO…ZI55U` | `canberra.` | false |
| `GDWUSKGG…5DIAG` | `Sydney` | true |

`reconciliation.method` is `exact-match-fallback`, with
`llmError: "ANTHROPIC_API_KEY not configured"`.

**2. Re-derive the consensus by hand.** Normalizing (trim, lowercase, strip
punctuation) gives `canberra`, `canberra`, `sydney`. The plurality is
`canberra`: 2 of 3 workers, confidence 2/3 ≈ 0.667. The representative text
is the first answer in that group, `Canberra`. The quorum isn't unanimous,
so the fast path correctly wasn't taken. 0.667 ≥ `minConfidence` 0.6, and at
least one worker matched, so the decision must be `resolve`, crediting
`GCFIRY65…` and `GCATS5YO…` and slashing `GDWUSKGG…`. This matches the
committed `result` and `decision`.

**3. Recompute the commitment in another language.** Python's `json.dumps`
with sorted keys and compact separators is JCS-equivalent for this record:

```sh
$ python3 -c 'import json,hashlib; e=json.load(open("docs/provenance-example.json")); \
  print(hashlib.sha256(json.dumps(e["record"],sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest())'
840486a5e134c38200c6bc4083ffda19a629a7aa6153bf16a9633193b4cde849
```

This equals the published `hash`.

**4. Run the verifier:**

```
$ node scripts/verify-provenance.js --file docs/provenance-example.json \
    --expected-hash 840486a5e134c38200c6bc4083ffda19a629a7aa6153bf16a9633193b4cde849
Question 1042: "What is the capital of Australia?"
Method: exact-match-fallback · submissions: 3 · decision: resolve
Committed hash: 840486a5e134c38200c6bc4083ffda19a629a7aa6153bf16a9633193b4cde849

Commitment and re-derivation
  ✓ record hash recomputes to the committed hash
  ✓ committed hash matches the independently published hash
  ✓ supported record version (1)
  ✓ fast path correctly not taken
  ✓ consensus matches a fresh exact-match vote
  ✓ matching workers match the vote
  ✓ confidence matches the vote
  ✓ LLM failure reason recorded
  ✓ decision (resolve) follows from the result

VERIFIED
```

**5. Tampering is caught.** Edit the third answer from `Sydney` to
`Canberra`, as if someone tried to make the quorum look unanimous after the
fact:

```
Commitment and re-derivation
  ✗ record hash recomputes to the committed hash  [c7392a9a3b4892dde74ca6c7225976a7963cbb10300b0a474a40d96728dbec27]
  ✓ supported record version (1)
  ✓ fast path correctly not taken
  ✓ consensus matches a fresh exact-match vote
  ✗ matching workers match the vote
  ✗ confidence matches the vote  [vote: 1]
  ...
VERIFICATION FAILED
```

**6. The payout.** This example was never settled on a real chain. For a
real question, add `--horizon <url> --contract <id>`. The verifier then
decodes the `resolve()` in `payoutTx` and confirms it credited exactly
`[GCFIRY65…, GCATS5YO…]` and slashed exactly `[GDWUSKGG…]` for question
`1042`. The test suite (`test/provenance.test.js`, "on-chain settlement
decoding") builds real `resolve()` envelopes, including fee-bumped ones,
and checks that decoder against both matching and mismatching payouts.

To run steps 4–6 against a real testnet question from your own stack, see
[local-full-stack.md](./local-full-stack.md), step 4c.

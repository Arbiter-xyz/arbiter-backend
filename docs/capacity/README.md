# Capacity report

This report answers one question: which part of the system breaks first under
load, and at what load? It has three parts:

1. **Measured locally.** Real runs of [`scripts/loadtest.js`](../../scripts/loadtest.js)
   against a local backend. They cover every part of the request path that works
   without a chain: HTTP, the store, the async job lifecycle, and SSE dispatch.
2. **Derived from the code.** The on-chain settlement ceiling. All
   `resolve()`/`refund()`/`charge()`/`touch()` calls go through one signing key
   and one serial queue. Section 2 explains why that makes settlement, not HTTP
   or SSE, the limit.
3. **Not done yet: the live testnet run** that issue #168 asks for. It has to be
   run by whoever operates the deployment, because it pushes load until
   something breaks. Section 4 gives the exact procedure. The local numbers
   below are the baseline to compare it against.

## 1. Measured locally (2026-09-24)

**Setup.** The backend (`node src/server.js`) and the load generator ran on
the same laptop, so they competed for CPU. Treat these numbers as a lower
bound for one backend instance.

| | |
|---|---|
| Machine | Intel Core i5-4300U (2 cores / 4 threads, 1.9 GHz), 11 GiB RAM, Linux 7.0 |
| Runtime | Node 22.22, one process, in-memory store (no `REDIS_URL`) |
| Logging | `LOG_FORMAT=json LOG_LEVEL=info` (every request logged, as in production), output discarded |
| Rate limits | `ORACLE_RATE_LIMIT_MAX`, `SANDBOX_RATE_LIMIT_MAX`, and `WORKER_RATE_LIMIT_MAX_CONNECTIONS` raised to 10⁸, so the per-IP limiter isn't what gets measured |
| Load model | Closed loop, step ramp. A stage breaks at > 5% errors or HTTP p95 > 500 ms |

Raw results: [`results/2026-09-24-local/`](./results/2026-09-24-local/).

### `read`: `GET /health`, `/stats`, `/leaderboard` (10 s stages)

| Virtual users | req/s | p50 | p95 | p99 | Errors |
|---:|---:|---:|---:|---:|---:|
| 1 | 866 | 1 ms | 2 ms | 4 ms | 0% |
| 10 | 1,831 | 4 ms | 11 ms | 15 ms | 0% |
| 100 | 1,887 | 49 ms | 75 ms | 105 ms | 0% |
| 400 | 1,829 | 96 ms | 165 ms | 6,979 ms | 0% |

Throughput levels off at about **1,850 req/s** from 10 users up. Adding more
users only adds queueing: p99 goes from 105 ms to 7 s. The limit is CPU on a
single Node process.

### `challenge`: `POST /oracle` step 1, the 402 quote (10 s stages)

| Virtual users | req/s | p50 | p95 | p99 | Errors |
|---:|---:|---:|---:|---:|---:|
| 10 | 1,273 | 6 ms | 15 ms | 20 ms | 0% |
| 100 | 1,347 | 68 ms | 111 ms | 146 ms | 0% |
| 200 | 1,270 | 88 ms | 164 ms | 2,127 ms | 0% |

Peaks at about **1,300 quotes/s**. Each quote does more work than a read
(question-id increment, stash write, pricing).

### `sandbox`: the full async job lifecycle, submit → poll → settled (20 s stages)

| Virtual users | Jobs settled/s | Job p50 | Job p95 | HTTP req/s | HTTP p95 | Verdict |
|---:|---:|---:|---:|---:|---:|---|
| 100 | 127 | 771 ms | 911 ms | 491 | 30 ms | ok |
| 200 | 254 | 789 ms | 880 ms | 978 | 47 ms | ok |
| 300 | **320** | 927 ms | 1,123 ms | 1,224 | 113 ms | ok |
| 400 | 300 | 1,180 ms | 2,655 ms | 1,031 | 307 ms | ok |
| 600 | 261 | 1,258 ms | 11,522 ms | 796 | 672 ms | **broken** |

About 0.75 s of each sandbox job is the sandbox's own simulated delay. Jobs
peak at about **320/s**. Beyond that, total throughput *falls*: the process
spends its time answering polls instead of finishing jobs. Clients polling
every 250 ms make up about 75% of all HTTP traffic here.

### `sse`: open worker streams (`GET /app/events`), with `/health` probed during each stage (20 s stages)

| Open streams | Server-reported `onlineWorkers` | Connect p95 | `/health` p95 during stage | Errors |
|---:|---:|---:|---:|---:|
| 1,000 | 1,000 | 48 ms | 4 ms | 0% |
| 8,000 | 8,000 | 41 ms | 5 ms | 0% |
| 20,000 | 20,000 | 486 ms | 5 ms | 0% |

The backend held **20,000 simultaneous worker streams** without breaking,
using about 456 MB RSS (roughly 22 KB per stream). An idle open stream costs
almost nothing: `/health` latency was the same at 20,000 streams as at 100.
Only the connect burst slows down. The practical ceiling is memory and the
process's file-descriptor limit, far above any realistic worker count. This
run did **not** measure broadcast fan-out, meaning writing one question to N
streams: that only happens on the paid path, which needs a chain (see
section 4).

## 2. The actual bottleneck: on-chain settlement is serialized

Every admin transaction is signed by one key (`PLATFORM_SECRET`). Stellar
requires strictly increasing sequence numbers, so
[`stellarClient.js`](../../src/stellarClient.js) runs every admin call through
one serial queue (`createSerialQueue`). Each call finishes its whole
`getAccount → prepareTransaction → send → pollTransaction` cycle, including
waiting for its ledger to close, before the next call starts.

| | Admin transactions per question | Ceiling with one signer |
|---|---|---|
| Pay-per-call (`submit()` by payer, then `resolve()`/`refund()`) | 1 | ≈ 1 per ledger ≈ **0.1–0.2 questions/s** (6–12/min) |
| Prepaid balance / API key (`charge()` then `resolve()`) | 2 | ≈ **0.05–0.1 questions/s** (3–6/min) |

These figures assume Stellar's ~5 s target ledger close and one to two ledgers
per admin call (the submission lands in the next ledger, then polling
confirms it). That is at least **three orders of magnitude below** every
limit measured in section 1 (≈320 jobs/s, ≈1,300 quotes/s, 20k streams). So
the HTTP layer, the store, and SSE dispatch are not what limits this system.
One signing key is.

The same queue has a worse consequence. Once a day, `sweepWorkerTtls()` in
[`dispatch.js`](../../src/dispatch.js) queues one `touch()` per known worker
(up to `MAX_TRACKED_WORKERS` = 5,000) on that queue. Settlement calls queued
during a sweep wait behind every pending touch:

| Known workers | Sweep duration at 1–2 ledgers per touch |
|---:|---|
| 100 | ≈ 8–17 min |
| 1,000 | ≈ 1.4–2.8 h |
| 5,000 | ≈ 7–14 h |

A question's `refund_timeout()` opens after `TIMEOUT_LEDGERS` (default 100,
≈ 8 min). With more than about 100 known workers, questions that settle
during the sweep can be force-refunded by the payer before `resolve()` gets
its turn. The workers who answered would then go unpaid (outcome
`lost_race_to_timeout_refund`). This comes from reading the code; confirming
it on a live deployment is part of section 4.

## 3. Recommendations

1. **Settle before TTL maintenance (small, do first).** Give the admin queue
   two priorities: `resolve`/`refund`/`charge` always go before `touch`. Also
   run the daily sweep in small batches rather than as one `Promise.all` over
   every worker. This removes the missed-payout risk above without changing
   throughput. It's local to `stellarClient.js` and `dispatch.js`.
2. **Multi-signer settlement pool (#161): raises the ceiling.** Sequence
   numbers are per *source account*, not per authorizer. So N channel
   accounts can each act as a transaction's source (each with its own
   sequence number), while the admin key only signs the Soroban
   authorization entry that satisfies `admin.require_auth()` (nonce-based,
   no sequence number). That gives roughly N× settlement throughput with no
   contract change. Fee-bumping alone doesn't help: the inner transaction
   still uses the admin's sequence number. The measurements show the rest of
   the stack has more than 1,000× headroom, so this is the change that
   actually moves capacity. Measure before and after with the paid-path
   procedure below.
3. **Push instead of poll (later).** At the sandbox peak, polling is about
   75% of HTTP load. Streaming job status over SSE, or long-poll on
   `GET /oracle/:jobId`, would remove most of that load. That only matters
   after (2), and scaling horizontally with Redis already covers it.

## 4. Running the live testnet test (#168)

Only run this against a deployment you operate. It pushes load until
something breaks. `scripts/loadtest.js` refuses a non-local `--target`
unless you pass `--i-operate-this-target`.

1. **Prepare the target.** Raise the per-IP limits for the test window, or
   they are all you'll measure (the tool counts 429s separately and stops
   with `RATE-LIMITED`): `ORACLE_RATE_LIMIT_MAX`, `SANDBOX_RATE_LIMIT_MAX`,
   `WORKER_RATE_LIMIT_MAX_CONNECTIONS`. Record the instance size, replica
   count, and whether `REDIS_URL` is set.
2. **Run the no-chain scenarios** from a machine that isn't the target:

   ```sh
   T=https://your-deployment.example.com
   node scripts/loadtest.js --target $T --i-operate-this-target --scenario read      --stages 10,50,100,200,400    --out read.json
   node scripts/loadtest.js --target $T --i-operate-this-target --scenario challenge --stages 10,50,100,200        --out challenge.json
   node scripts/loadtest.js --target $T --i-operate-this-target --scenario sandbox   --stages 50,100,200,300,400   --out sandbox.json
   node scripts/loadtest.js --target $T --i-operate-this-target --scenario sse       --stages 500,2000,5000,10000 --out sse.json
   ```

   Proxies and platform connection caps in front of the app (for example,
   Railway's edge) will show up here as limits the local run couldn't have.
3. **Run the paid path.** This is where section 2's ceiling shows up. Use
   `arbiter-app`'s `demo-agent` (see [local full stack](../local-full-stack.md)):
   start several `worker-sim.js` instances, then run K concurrent `ask.js`
   payers, each with its own funded `DEMO_PAYER_SECRET`, for K = 1, 2, 4, 8.
   Record submit-to-settled time and each job's `outcome`. Expect settled
   questions per minute to level off near one per ledger, and
   `lost_race_to_timeout_refund` to appear once the queue backs up past
   `TIMEOUT_LEDGERS`. Run it once more during a TTL sweep to confirm or
   refute the sweep risk in section 2.
4. **Add a dated section to this file** with the same tables, and commit the
   JSON under `results/<date>-testnet/`.

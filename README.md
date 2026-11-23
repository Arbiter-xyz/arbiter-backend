# arbiter-backend

The Express/Node backend for **Arbiter**, a pay-per-question
human-intelligence oracle settled on Stellar/Soroban. Terminates the HTTP
402 payment flow, dispatches questions to workers over SSE, reconciles
answers, and settles on-chain against
[arbiter-contract](https://github.com/Arbiter-xyz/arbiter-contract). It's
the sole holder of the platform's admin key — the only component allowed
to call `resolve()`/`refund()`/`touch()` — and, separately, the pooled
fiat-onramp float key (kept deliberately distinct; see "Billing" below).

Originally split out of a monorepo; that monorepo is now retired — this
repo is the sole source of truth for the backend's code going forward,
version-pinned against `arbiter-contract`'s releases rather than kept in
lockstep by hand (see #163). Pre-split history and the round-by-round
build narrative live in the archived
[`arbiter`](https://github.com/rudeus112266/arbiter) repo.

## Try it locally

There is **no public hosted deployment yet**. Earlier revisions of this
README advertised `https://sandbox.arbiter.xyz` and
`https://demo.arbiter.xyz`; neither host is currently reachable, so they
are no longer documented as live targets. Do not point an integration at
them.

To try the backend, run it yourself (see
[`docs/local-full-stack.md`](docs/local-full-stack.md)):

```sh
npm install
npm start
```

That gives you a local instance on the port from `config.js` (default
`3000`), serving the app from `app/dist` unless `SERVE_STATIC_APP=false`.

### Zero-chain mode (`POST /oracle/sandbox`)

`/oracle/sandbox` (`backend/src/sandbox.js`) is a purely local simulation.
Its own docstring says it "Never touches stellarClient.js — no chain
calls," which is exactly why it's zero-setup, but also why it can't prove
anything about real Soroban RPC latency, real surge pricing, or a real
`submit()`/`resolve()`/`withdraw()` round trip. It returns canned response
shapes with no payment and no chain. Use it to see a response shape before
setting up a wallet.

### Funding a testnet USDC path

You do not need Arbiter's own platform key to get test funds. To fund your
own integration against a locally run instance:

1. Create and fund a testnet Stellar account with Friendbot:
   `curl "https://friendbot.stellar.org?addr=<YOUR_TESTNET_ADDRESS>"`.
2. Add a trustline for the testnet USDC asset issued by the deployment you
   are running (see its `/health` response and the
   `arbiter-contract` testnet deployment notes for the current issuer and
   asset code).
3. Acquire testnet USDC from a documented testnet faucet, or
   from any testnet DEX path against that issuer, and pay for questions
   from your own key.

This keeps your integration independent of Arbiter's platform key and of
any single hot key's funding.

## Teams and member roles

Team/organization accounts (`teams.js`) are a named group of Stellar
addresses that can see each other's question history and spend in one
place. A team adds no new credential: it is a membership list over
existing identities, so every member keeps paying from, and owning, their
own address. Roles, strongest first:

- **owner** — exactly one per team. Everything an admin can do, plus
  promoting/demoting admins, transferring ownership, and deleting the
  team. Can't leave or be removed without first transferring ownership, so
  a team is never ownerless.
- **admin** — add and remove plain members, rename the team.
- **member** — read the team and its combined question history; leave.

## Static frontend hosting (`SERVE_STATIC_APP`)

By default the backend also serves the built worker-console/dashboard/
leaderboard SPA from `app/dist` via `express.static`, which is what makes
`npm start`-style local and single-process demo runs work out of the box.

In production the app build is deployed separately and fronted by a static
host, so the backend does not need to serve those assets at all. Set `SERVE_STATIC_APP=false` to skip mounting the
`express.static` middleware entirely — static-asset requests then fall
through to the normal 404 handler instead of being served by the same
process that handles latency-sensitive settlement traffic. Leave it unset
(or `true`) for local dev and small single-process deployments where the
backend is the only thing serving the app.

## What it does

- Async job-based `/oracle` — `202` immediately once payment is confirmed,
  clients poll `GET /oracle/:jobId` rather than holding a connection open.
  Three payment methods on the one endpoint: classic pay-per-call
  `submit()`, a prepaid on-chain balance for a wallet-holding payer, or an
  `Authorization: Bearer` API key for a payer with no wallet at all (see
  Billing below) — chosen transparently by what the caller sends.
- `POST /oracle/sandbox` — a zero-payment, zero-chain, zero-LLM sandbox
  endpoint so an integrator can see a real response shape before setting
  up a wallet.
- Live surge pricing, worker category routing, staking/reputation-gated
  reconciliation fast path (with an on-chain stake-gate opt-in for
  dispatch eligibility), Web Push for offline workers, structured (pino)
  logging with request/job correlation, idempotent job creation, and
  bounded retry/timeout on every external call (Claude, Soroban RPC,
  Horizon).
- **Private worker pools** (`privatePools.js`) — a payer can whitelist
  worker addresses (`GET`/`POST /payers/:address/pool`,
  `DELETE /payers/:address/pool/:worker`, session-token gated). Their
  questions then go only to, and only take answers from, those workers.
  This **fails closed**: if no whitelisted worker is online, the question
  is refunded rather than sent to the open pool. Payers without a pool
  are unaffected.
- **Configurable consensus rules** (`consensus.js`) — `consensusMode:
  'numeric-tolerance'` with `tolerance: { percent }` or `{ absolute }` on
  `POST /oracle` makes numeric answers ("42", "$42.00", "about 42") within
  tolerance count as agreeing, without a Claude call. The default `'exact'`
  mode is unchanged. The rule used is shown on `GET /oracle/:jobId`.
- Cryptographic worker session auth (`workerAuth.js`) — an address-format
  `workerId` must prove control of that key before submitting an answer.
- A read-only admin/ops console (`/admin/*`, bearer-token gated) —
  transactions, workers, payers, live on-chain treasury balance, fee
  revenue, and fraud/trust monitoring. Its list/summary reads can go to a
  Redis read replica (`REDIS_REPLICA_URL`, `replicaStore.js`) so an operator
  browsing the console never competes with settlement for the primary; a
  failing replica falls back to the primary, and `GET /admin/read-replica`
  reports which one is in use and the replica's lag.
- **Payer referrals (`payerReferrals.js`)** — a payer who passes a worker's
  referral code (`body.referralCode` on `POST /oracle`) on their first
  verified payment is attributed to that worker, once and permanently, with
  an informational credit (`PAYER_REFERRAL_REWARD_BPS` of that payment)
  listed at `GET /admin/referral-earnings`. Bookkeeping only: nothing is
  paid out.
- **Canary deployments ([docs/runbooks/canary-deployment.md](docs/runbooks/canary-deployment.md))** —
  `INSTANCE_ROLE=canary` serves read-only traffic and never signs as the
  platform key; a fleet-wide signer lock stops two instances racing the
  platform account's sequence number; SIGTERM drains in-flight questions
  before exit; `npm run canary:preflight` checks a canary matches the primary.
- Every environment variable the code reads is documented in
  [`.env.example`](.env.example); `npm run check:env` (run in CI) fails on drift.
- A SEP-24/SEP-12 fiat anchor client (`anchorClient.js`) — Arbiter never
  holds PII or bank details itself, only resolves and caches the
  configured anchor's public `stellar.toml` for the frontend.
- **Billing (`billing.js`)** — the non-crypto onramp: a customer pays via
  Stripe Checkout and is issued an API key instead of ever touching a
  Stellar wallet. Every fiat-paid quest

## Webhooks

Instead of polling `GET /oracle/:jobId` until a question settles, an
integrator can register a webhook and receive a signed `POST` when the
question's outcome is final. Webhooks are managed by `webhooks.js` and
delivered by `webhookDelivery.js`.

### Registering, listing, and deleting

All three endpoints accept **either** auth mode:

- `Authorization: Bearer <API_KEY>` — the same API key issued by Billing
  (`billing.js`), or
- `Authorization: Bearer <SESSION_TOKEN>` — a session/JWT token for a
  Stellar address, in which case the webhook is owned by that address.

| Method & path | Purpose |
| --- | --- |
| `POST /webhooks` | Register a webhook. Body: `{ url, events? }`. Returns the webhook plus a one-time `secret`. |
| `GET /webhooks` | List the caller's webhooks (secrets are never returned). |
| `DELETE /webhooks/:id` | Delete one of the caller's webhooks. |

`POST /webhooks` responds `201` with the webhook record and a `secret`:

```json
{
  "id": "wh_...",
  "url": "https://example.com/arbiter-hook",
  "events": ["question.settled"],
  "secret": "whsec_...",
  "note": "Store `secret` now — it is never shown again. Verify each delivery's X-Arbiter-Signature with it (see README \"Webhooks\")."
}
```

**Store `secret` immediately.** It appears in this response and nowhere
else, ever — `GET /webhooks` will not return it again. If you lose it,
delete the webhook and register a new one.

### The `question.settled` payload

When a question reaches a final outcome, Arbiter delivers a `POST` to each
registered URL with a JSON body of the form:

```json
{
  "event": "question.settled",
  "deliveryId": "dlv_...",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "data": {
    "jobId": "...",
    "questionId": "...",
    "status": "settled",
    "answer": "...",
    "payer": "G...",
    "txHash": "..."
  }
}
```

Treat the body as opaque beyond the fields you need; new fields may be
added over time. Always verify the signature before acting on a delivery.

### Verifying `X-Arbiter-Signature`

Every delivery carries an `X-Arbiter-Signature` header of the form
`sha256=<hex>`, where `<hex>` is the lowercase hex HMAC-SHA256 of the
**raw request body** (the exact bytes received, before any JSON parsing)
keyed by your webhook `secret`. This is what `computeSignature()` in
`webhookDelivery.js` produces.

Node (Express, using the raw body):

```js
const crypto = require('crypto');

function verifyArbiterSignature(rawBody, secret, header) {
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Mount BEFORE express.json() so req.body is the raw Buffer:
app.post('/arbiter-hook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifyArbiterSignature(req.body, process.env.ARBITER_WEBHOOK_SECRET, req.get('X-Arbiter-Signature'))) {
    return res.status(401).send('bad signature');
  }
  const event = JSON.parse(req.body.toString('utf8'));
  // handle event...
  res.status(200).send('ok');
});
```

Python (Flask):

```python
import hashlib, hmac


def verify_arbiter_signature(raw_body: bytes, secret: str, header: str) -> bool:
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, header or "")


@app.post("/arbiter-hook")
def arbiter_hook():
    raw = request.get_data()  # raw bytes, not request.json
    if not verify_arbiter_signature(raw, os.environ["ARBITER_WEBHOOK_SECRET"], request.headers.get("X-Arbiter-Signature")):
        return "bad signature", 401
    event = json.loads(raw)
    # handle event...
    return "ok", 200
```

Use a constant-time comparison (as above) and always compute the HMAC over
the raw bytes — re-serializing the parsed JSON will change the bytes and
break verification.

### Retries and deactivation

- A delivery that does not receive a `2xx` response is retried with
  backoff, up to a bounded number of attempts.
- Respond `2xx` as soon as you have durably accepted the event; do the
  real work asynchronously. Deliveries may be retried, so make your handler
  idempotent (dedupe on `deliveryId`).
- A webhook whose endpoint keeps failing is deactivated automatically
  after repeated delivery failures. Re-register it (and store the new
  `secret`) to resume deliveries.

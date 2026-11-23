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

## Maintenance windows and dispatch pauses

During a scheduled maintenance window or holiday, the backend can pause
dispatch. While a pause is in effect, `POST /oracle` rejects new questions
with `503 Service Unavailable` and a `Retry-After` header, and clients can
poll `GET /maintenance` to see the pause and any upcoming windows.

### `GET /maintenance`

Public, like `/health` — no auth required. Returns the dispatch pause in
effect (if any) and every scheduled maintenance/holiday window still ahead,
so clients and workers can plan around them. Implemented in
`src/server.js`; window scheduling lives in `maintenanceWindows.js`.

Response fields:

- `dispatchPaused` — boolean; `true` while a dispatch pause is in effect.
- `reason` — present only when `dispatchPaused` is `true`; a human-readable
  description of the pause.
- `resumesAt` — present only when `dispatchPaused` is `true`; ISO 8601
  timestamp at which dispatch is expected to resume.
- `windows` — array of upcoming scheduled windows (serialized via
  `serializeWindow`), each describing a maintenance/holiday window still
  ahead of the current time.

Not paused:

```json
{
  "dispatchPaused": false,
  "windows": [
    {
      "id": "holiday-2025-12-25",
      "reason": "Christmas holiday",
      "startsAt": "2025-12-25T00:00:00.000Z",
      "endsAt": "2025-12-26T00:00:00.000Z"
    }
  ]
}
```

Paused:

```json
{
  "dispatchPaused": true,
  "reason": "Scheduled maintenance",
  "resumesAt": "2025-06-01T12:00:00.000Z",
  "windows": []
}
```

### `POST /oracle` during a pause

While a dispatch pause is in effect, `POST /oracle` rejects the request with
`503 Service Unavailable` and a `Retry-After` header (seconds to wait before
retrying). The rejection helper lives alongside the route in `src/server.js`.

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 3600
Content-Type: application/json

{
  "error": "Dispatch is paused for scheduled maintenance",
  "resumesAt": "2025-06-01T12:00:00.000Z"
}
```

### How clients should back off

- On `503` from `POST /oracle`, honour the `Retry-After` header: wait at
  least that many seconds before retrying. Do not retry in a tight loop.
- Optionally poll `GET /maintenance` to learn when dispatch resumes
  (`resumesAt`) and to see upcoming windows, rather than retrying blindly.
- Once `dispatchPaused` is `false` (or `resumesAt` has passed), resume
  normal submission.

## Fiat anchor routes (`/anchor/config`, `/anchor/report`)

Arbiter is a **client** of one configured SEP-24/SEP-12 anchor (see
`anchorClient.js`), never a money transmitter itself. The frontend drives
SEP-10 auth and the SEP-24 interactive deposit/withdraw flow directly
against the anchor — that's the only way it can work, since the anchor's
JWT is gated by the account holder's own signature, which this backend
never has. The backend exposes two small routes to support that flow.

### `GET /anchor/config`

Returns the anchor configuration the frontend needs to start the SEP-10 /
SEP-24 flow: the anchor's home domain and the resolved public
`stellar.toml` fields (cached by `anchorClient.js`). No auth required — it
only exposes the anchor's public metadata.

`ANCHOR_HOME_DOMAIN` selects which anchor this deployment talks to: it is
the anchor's home domain (e.g. `anchor.example.com`), from which the
backend resolves `https://<ANCHOR_HOME_DOMAIN>/.well-known/stellar.toml`
to discover the anchor's `WEB_AUTH_ENDPOINT`, `TRANSFER_SERVER_SEP0024`,
and signing key. Set it to point the deployment at a different anchor;
leave it unset to disable the fiat-anchor routes.

### `POST /anchor/report`

This backend's only write path for the anchor flow. A self-authenticated
user tells us what their own browser observed during a deposit/withdraw,
purely so the admin console has something to show (see `admin.js`'s
`listAnchorPayouts`/`listAnchorKyc` for that caveat).

Request body fields:

- `kind` — what is being reported (e.g. a payout or a KYC status update).
- `status` — the status the user's browser observed.
- `anchorTransactionId` — the anchor-side transaction id, when known.
- `amount` / `asset` — the amount and asset involved, when known.
- `note` — free-form detail from the client.

**Reports are self-reported and are NOT verified by the backend.** They
are informational only: the backend does not confirm them against the
anchor, and they are surfaced in the admin console as-is. Treat them as a
hint, not as authoritative state.

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
  tolerance count as agreein

/* … truncated 2191 chars — edit only what you need near the top … */

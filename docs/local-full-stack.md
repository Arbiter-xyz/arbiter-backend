# Running the full stack locally

Arbiter is split across three repos. Each README explains how to run that
repo on its own. This guide explains how to get all three talking to each
other:

```
arbiter-contract  (Soroban escrow, deployed to testnet)
      ▲  resolve()/refund()/charge()/touch() signed by PLATFORM_SECRET
arbiter-backend   (this repo, http://localhost:4000)
      ▲  VITE_BACKEND_URL / BACKEND_URL
arbiter-app       (worker console on http://localhost:5173, plus demo-agent scripts)
```

There is no local chain here. The contract is deployed to Stellar
**testnet**, and the backend and app run on your machine.

**Prerequisites:** Node 22+, git, Rust with the
[`stellar` CLI](https://developers.stellar.org/docs/tools/cli) (its install
guide covers the wasm target), and `curl`.

## 0. Three clones, pinned to versions that work together

```sh
mkdir arbiter && cd arbiter
git clone https://github.com/Arbiter-xyz/arbiter-contract
git clone https://github.com/Arbiter-xyz/arbiter-backend
git clone https://github.com/Arbiter-xyz/arbiter-app
```

Don't just deploy whatever is on the contract's `main`. The backend calls
specific contract methods (`resolve`, `refund`, `charge`, `touch`, `get_*`,
and so on) with specific argument shapes, so pin a contract version this
backend is known to work with:

| arbiter-backend | arbiter-contract | arbiter-app |
|---|---|---|
| this commit | `7e5c893fde74`: every contract method this backend calls exists there by name (checked 2026-09-24) | `ce92f3bce086` |

```sh
git -C arbiter-contract checkout 7e5c893fde74
git -C arbiter-app checkout ce92f3bce086
```

Once `arbiter-contract` publishes tagged releases (#133) and the backend
reports the contract version it expects (#163/#150), replace this table with
`git checkout <tag>` steps. Whoever lands that change should update this
table in the same PR.

## 1. Deploy the contract to testnet

```sh
cd arbiter-contract
cargo test                  # sanity check: no chain needed
stellar contract build      # prints the path of oracle_escrow.wasm

# One funded testnet key acts as both admin and fee recipient ("platform").
stellar keys generate arbiter-admin --network testnet --fund
ADMIN=$(stellar keys address arbiter-admin)

# The Stellar Asset Contract id for testnet USDC (the issuer is the backend's default USDC_ASSET_ISSUER).
USDC_SAC_ID=$(stellar contract asset id --network testnet \
  --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5)

ORACLE_CONTRACT_ID=$(stellar contract deploy --network testnet --source arbiter-admin \
  --wasm <path printed by stellar contract build>)

stellar contract invoke --network testnet --source arbiter-admin --id "$ORACLE_CONTRACT_ID" -- \
  initialize --admin "$ADMIN" --token "$USDC_SAC_ID" --platform "$ADMIN" --timeout_ledgers 100

echo "ORACLE_CONTRACT_ID=$ORACLE_CONTRACT_ID  USDC_SAC_ID=$USDC_SAC_ID  PLATFORM_ADDRESS=$ADMIN"
stellar keys show arbiter-admin   # the secret, for PLATFORM_SECRET below
cd ..
```

`--timeout_ledgers` sets how long a payer waits before `refund_timeout()`
becomes available. The backend's `TIMEOUT_LEDGERS` must be set to the same
value.

## 2. Point a local backend at that contract

```sh
cd arbiter-backend
npm ci
cp .env.example .env
```

Set these in `.env`, using the values printed in step 1:

```sh
ORACLE_CONTRACT_ID=C...
USDC_SAC_ID=C...
PLATFORM_SECRET=S...            # arbiter-admin's secret: the only key allowed to resolve()/refund()
PLATFORM_ADDRESS=G...           # arbiter-admin's address
TIMEOUT_LEDGERS=100             # must match initialize()
ALLOWED_ORIGINS=http://localhost:5173
# Optional: ANTHROPIC_API_KEY=... enables LLM reconciliation and the instant tier.
# Without it, reconciliation falls back to the deterministic vote.
```

```sh
npm start
curl -s localhost:4000/health   # {"ok":true,"onlineWorkers":0,"contractId":"C..."}
cd ..
```

Local dev needs no `SESSION_SECRET`, Redis, or CORS lockdown. The startup
security check (`src/securityPosture.js`) only complains in a deployment
that looks like production.

## 3. Point a local app at that backend

```sh
cd arbiter-app/app
npm install
cp .env.example .env    # set VITE_BACKEND_URL=http://localhost:4000 and VITE_ORACLE_CONTRACT_ID=C...
npm run dev             # http://localhost:5173
```

Use Vite's dev server. The backend's own static route serves `../../app/dist`,
which was a monorepo path and doesn't resolve with three side-by-side clones.

## 4. Check that it works end to end

**a. No chain involved** (confirms app/demo → backend wiring):

```sh
cd arbiter-app/demo-agent
npm install
cp .env.example .env    # BACKEND_URL=http://localhost:4000, ORACLE_CONTRACT_ID=C...
node sandbox-ask.js "What year did Stellar launch?"
```

A settled job (`sandbox: true`) means the app side can reach the backend.

**b. The real paid flow** (payment → dispatch → reconcile → `resolve()` on
your contract):

1. Create two more funded testnet keys: `stellar keys generate demo-payer --network testnet --fund`
   and `stellar keys generate demo-worker --network testnet --fund`.
2. Give the payer testnet USDC. Add a trustline with
   `stellar tx new change-trust --network testnet --source demo-payer --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`,
   then fund it from Circle's testnet faucet (<https://faucet.circle.com>, Stellar testnet).
3. In `demo-agent/.env`, set `DEMO_PAYER_SECRET` to the payer's secret and
   `WORKER_SECRET` to the worker's secret. `resolve()` credits workers by
   Stellar address, so the worker needs a real key, not a plain-string
   `WORKER_ID`.
4. Terminal 1: `node worker-sim.js`. It connects over SSE; `/health` should now show `"onlineWorkers":1`.
5. Terminal 2: `node ask.js "What is the capital of France?"`.

The standard tier waits up to 45 s for its quorum of 3, and then reconciles
whatever arrived. With one worker, expect a job that settles with
`outcome: "resolved"`, a `payoutTx`, and a `provenanceHash`. Opening the
worker console on `localhost:5173` with the worker's key shows the credited
balance.

**c. Verify the settlement independently** (see [provenance.md](./provenance.md)):

```sh
cd arbiter-backend
node scripts/verify-provenance.js --backend http://localhost:4000 --job <jobId from ask.js> \
  --horizon https://horizon-testnet.stellar.org --contract <ORACLE_CONTRACT_ID>
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/health` shows `"contractId":""` | `.env` not picked up. Run `npm start` from the backend repo root. |
| `ask.js`: `payment not yet visible on-chain` | The `submit()` transaction hasn't landed yet. It retries; testnet ledgers close about every 5 s. |
| Job settles `refund_pending_timeout` with `on-chain resolve failed` | `PLATFORM_SECRET` isn't the key passed as `--admin` to `initialize`, or a worker id isn't a valid `G...` address. |
| Browser console shows CORS errors | `ALLOWED_ORIGINS` doesn't include `http://localhost:5173`. |
| `initialize` fails with `AlreadyInitialized` | The contract id is from an earlier deploy. Deploy a fresh instance. |

# Sessions

Most payer and worker routes require a **session token**. A session token is a short-lived bearer credential that proves control of a Stellar account (the "address"). You obtain one by signing a challenge transaction with the address key and exchanging the signed XDR for a token.

The same flow is mounted twice:

- Payer routes: `/payers/:address/session*`
- Worker routes: `/workers/:address/session*`

Both mounts are rate limited per IP. The only difference between them is which address namespace the token is valid for; a token issued under `/payers` will not authenticate `/workers` routes and vice versa.

The flow has four steps:

1. Request a challenge.
2. Sign the challenge XDR with the address key.
3. Exchange the signed XDR for a session token.
4. Send the token on subsequent requests.

Revocation is a fifth, optional step.

## 1. Request a challenge

```
POST /payers/:address/session/challenge
POST /workers/:address/session/challenge
```

No body is required. The response is:

```json
{ "xdr": "AAAAAgAAAAB..." }
```

The `xdr` is a base64-encoded, SEP-10-style challenge transaction. It is a throwaway transaction: it is **never submitted to the network** and has no effect on chain state. It exists only to be signed. If the address is malformed the endpoint responds with `400` and `{ "error": "..." }`.

## 2. Sign the challenge XDR

Sign the returned XDR with the key that controls `:address`. The signature must be produced over the network passphrase the backend is configured for (the Stellar testnet or mainnet passphrase, depending on deployment).

### JavaScript SDK example

```js
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

const address = keypair.publicKey(); // the address you are authenticating as
const base = '/payers'; // or '/workers'

// 1. Request the challenge
const challengeRes = await fetch(`${base}/${address}/session/challenge`, {
  method: 'POST',
});
const { xdr } = await challengeRes.json();

// 2. Sign it
const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET); // use Networks.PUBLIC on mainnet
tx.sign(keypair);
const signedXdr = tx.toXDR();

// 3. Exchange for a token
const sessionRes = await fetch(`${base}/${address}/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ signedXdr }),
});
const session = await sessionRes.json();
```

The SDKs wrap these steps for you; see [`sdk/typescript/README.md`](../../sdk/typescript/README.md) and [`sdk/python/README.md`](../../sdk/python/README.md) for helper functions that request the challenge, sign it, and return a token in one call.

## 3. Exchange the signed XDR for a token

```
POST /payers/:address/session
POST /workers/:address/session
```

Request body:

```json
{ "signedXdr": "AAAAAgAAAAB..." }
```

On success the response contains the session token and its expiry:

```json
{ "token": "…", "expiresAt": "2024-01-01T12:00:00.000Z" }
```

Errors:

| Status | Cause |
| ------ | ----- |
| `400` | Missing `signedXdr` in the request body. |
| `401` | The signed XDR failed verification (bad signature, wrong address, expired or malformed challenge). |

## 4. Send the token on subsequent requests

Include the token alongside the address on any route that requires a session. The backend accepts the address and token either in the JSON body or in the query string:

```js
// JSON body
await fetch('/payers/...', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address, token, /* ...route fields */ }),
});

// Query string
await fetch(`/payers/...?address=${address}&token=${encodeURIComponent(token)}`, {
  method: 'POST',
});
```

A missing, expired, or invalid token results in `401`.

## Token lifetime

Session tokens are valid for `WORKER_SESSION_TTL_MS` milliseconds, defaulting to **12 hours**. The `expiresAt` field returned by step 3 tells you exactly when the current token stops being accepted. When a token expires, repeat the challenge/sign/exchange flow to obtain a new one.

## Secret rotation

Tokens are signed with `SESSION_SECRET`. To rotate the secret without invalidating every active session at once, set `SESSION_SECRET_PREVIOUS` to the old value and `SESSION_SECRET` to the new one. During the grace window, tokens signed with either secret are accepted; new tokens are always issued under `SESSION_SECRET`. Once the grace window has passed (at least the token TTL), remove `SESSION_SECRET_PREVIOUS`.

## Revocation

```
POST /payers/:address/session/revoke
POST /workers/:address/session/revoke
```

Request body:

```json
{ "token": "…" }
```

Revoking invalidates the token immediately, before its natural expiry. Use this when a key may be compromised or when a client is being decommissioned. The endpoint returns `401` if the supplied token is not valid for the given `:address` (for example, it has already expired, was issued for a different address, or was issued under the other mount).
# Referrals and Automated Onboarding

This page documents the referral endpoints and the one-call worker onboarding flow. All routes are served by `src/server.js` and backed by `src/referrals.js`.

Referral codes are tied to a real Stellar address. Minting and viewing your own referrals always requires a session token — there is no test-string convenience here, same as private pools. Onboarding proves control of the **new** address the same way: the challenge is signed offline, so it works before the account exists on-chain.

## Routes at a glance

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/referrals/:code` | none (public) | Check whether a referral code is valid and how many uses remain |
| `POST` | `/workers/:address/referral-code` | session token | Mint (or return) the caller's referral code |
| `GET` | `/workers/:address/referrals` | session token | List the referrer's code and the status of each referee |
| `POST` | `/workers/:address/onboard` | session token | Redeem a referral code and build the sponsored onboarding transaction |

---

## `GET /referrals/:code`

Public. Returns whether a referral code is valid and how many uses remain.

**Response `200`**

```json
{
  "valid": true,
  "code": "ARB-7F3K9Q2M",
  "remaining": 4
}
```

- `valid` — `true` when the code exists and has uses remaining.
- `code` — the normalized code.
- `remaining` — uses left before the code is exhausted.

**Errors**

- `404` — the code is unknown or exhausted.

```bash
curl https://api.example.com/referrals/ARB-7F3K9Q2M
```

---

## `POST /workers/:address/referral-code`

Mints the caller's referral code, or returns the existing one. Requires a session token for `:address`.

**Body**

```json
{ "token": "<session token>" }
```

**Response `200`**

```json
{
  "code": "ARB-7F3K9Q2M",
  "remaining": 5
}
```

Codes have the form `ARB-XXXXXXXX`. The number of uses per code is capped by `REFERRAL_MAX_USES_PER_CODE`.

**Errors**

- `400` — `:address` is not a valid Stellar address, or the body is malformed.
- `401` — missing or invalid session token.

```bash
curl -X POST https://api.example.com/workers/GABCD.../referral-code \
  -H 'Content-Type: application/json' \
  -d '{"token":"<session token>"}'
```

---

## `GET /workers/:address/referrals?token=...`

Lists the referrer's code and the status of each referee. Requires a session token for `:address`, passed as the `token` query parameter.

**Response `200`**

```json
{
  "code": "ARB-7F3K9Q2M",
  "remaining": 3,
  "referrals": [
    { "address": "GREF1...", "status": "qualified" },
    { "address": "GREF2...", "status": "pending" },
    { "address": "GREF3...", "status": "disqualified" }
  ]
}
```

Each referee has one of these statuses:

- `pending` — redeemed the code but has not yet qualified.
- `qualified` — met the qualification criteria.
- `disqualified` — did not qualify.

**Errors**

- `400` — `:address` is not a valid Stellar address.
- `401` — missing or invalid session token.

```bash
curl 'https://api.example.com/workers/GABCD.../referrals?token=<session token>'
```

---

## `POST /workers/:address/onboard`

Redeems a referral code (if supplied) and returns the sponsored account plus the USDC trustline transaction for the new address. Requires a session token for `:address` — the **new** address being onboarded.

**Body**

```json
{
  "token": "<session token for the new address>",
  "referralCode": "ARB-7F3K9Q2M"
}
```

`referralCode` is optional unless `REFERRAL_REQUIRED_FOR_SPONSORED_ONBOARDING` is `true`, in which case onboarding without a code is rejected.

**Response `200`**

```json
{
  "address": "GNEW...",
  "sponsored": true,
  "xdr": "AAAAAgAAAAB..."
}
```

- `xdr` — the unsigned transaction that creates the sponsored account and establishes the USDC trustline. Sign it with the new address's key and submit it to `POST /sponsor/onboard/submit`.

**Rules**

- One redemption per address.
- No self-referral: the referrer and referee must differ.
- No redemption after the address has answer history.
- Retries are idempotent: calling `/onboard` again for the same address returns the same result rather than consuming another use.

**Errors**

- `400` — `:address` is not a valid Stellar address, the body is malformed, or a referral code is required but missing.
- `401` — missing or invalid session token.
- `404` — the supplied `referralCode` is unknown or exhausted.
- `409` — the address has already redeemed a code, is self-referring, or already has answer history.
- `503` — the sponsor is temporarily unavailable.

```bash
curl -X POST https://api.example.com/workers/GNEW.../onboard \
  -H 'Content-Type: application/json' \
  -d '{"token":"<session token>","referralCode":"ARB-7F3K9Q2M"}'
```

---

## Full onboarding sequence

The challenge is signed offline, so the new account does not need to exist on-chain yet.

1. **Obtain a session token for the new address.** Request a challenge for the new address, sign it offline with the new address's key, and exchange the signature for a session token. (See the authentication docs for the challenge/sign flow.)
2. **Call `POST /workers/:address/onboard`** with `{ token, referralCode? }`. This redeems the code and returns the sponsored account + USDC trustline transaction as `xdr`.
3. **Sign the returned XDR** with the new address's key.
4. **Submit** the signed XDR to `POST /sponsor/onboard/submit`.

```bash
# 2. Build the onboarding transaction
curl -X POST https://api.example.com/workers/GNEW.../onboard \
  -H 'Content-Type: application/json' \
  -d '{"token":"<session token>","referralCode":"ARB-7F3K9Q2M"}'

# 4. Submit the signed transaction
curl -X POST https://api.example.com/sponsor/onboard/submit \
  -H 'Content-Type: application/json' \
  -d '{"xdr":"<signed xdr>"}'
```

---

## Configuration

| Variable | Effect |
| --- | --- |
| `REFERRAL_REQUIRED_FOR_SPONSORED_ONBOARDING` | When `true`, `POST /workers/:address/onboard` rejects requests without a `referralCode` (`400`). |
| `REFERRAL_MAX_USES_PER_CODE` | Maximum number of redemptions allowed per referral code. |

## Error codes

| Status | Meaning |
| --- | --- |
| `400` | Invalid Stellar address, malformed body, or missing required referral code. |
| `401` | Missing or invalid session token. |
| `404` | Referral code unknown or exhausted. |
| `409` | Address already redeemed, self-referral, or existing answer history. |
| `503` | Sponsor temporarily unavailable. |
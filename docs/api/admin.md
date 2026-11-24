# Admin API

This document describes every `/admin` route exposed by `src/server.js` (plus the
fault-injection routes mounted via `mountFaultRoutes`). These are operational /
support endpoints used by the ops console; they are **not** part of the public
API surface.

> **Out of scope:** this document describes existing behaviour only. It does
> not propose or describe any behaviour changes.

---

## Authentication

All `/admin` routes are gated by the `requireAdmin` middleware defined in
[`src/adminAuth.js`](../../src/adminAuth.js). The model is a **shared bearer
token**:

| Condition | Status | Body |
| --- | --- | --- |
| `ADMIN_TOKEN` env var is unset/empty | `503 Service Unavailable` | `{ "error": "admin disabled" }` |
| Missing or wrong `Authorization: Bearer <token>` | `401 Unauthorized` | `{ "error": "unauthorized" }` |
| Token valid but caller lacks required role | `403 Forbidden` | `{ "error": "forbidden" }` |

### Headers

| Header | Required | Purpose |
| --- | --- | --- |
| `Authorization: Bearer <ADMIN_TOKEN>` | Yes | Shared admin token. Compared in constant time. |
| `X-Admin-TOTP: <code>` | Optional | If `ADMIN_TOTP_SECRET` is configured, a valid TOTP code is required in addition to the bearer token. |
| `X-Admin-Role: <role>` | Optional | Selects the caller's role for role-gated routes (e.g. `ops`, `admin`). Defaults to the lowest privileged role when omitted. |

There is **no rate limit** on these routes: they do not spend a network fee, and
the bearer-token gate is the actual access control.

### State-changing routes

Routes that mutate state are marked **Mutating** below. Read-only routes are
marked **Read-only**. Callers should treat mutating routes as non-idempotent
unless otherwise noted.

---

## Common query parameters

Most listing routes accept the same pagination parameters:

| Parameter | Type | Default | Clamp | Notes |
| --- | --- | --- | --- | --- |
| `limit` | integer | `50` | max `200` | Values `<= 0` or non-numeric fall back to the default. |
| `offset` | integer | `0` | — | Negative values are treated as `0`. |

`/admin/collusion` uses different bounds: `limit` defaults to `100` and is
capped at `500`.

Listing responses share the shape:

```json
{
  "items": [ /* ... */ ],
  "limit": 50,
  "offset": 0
}
```

(Some routes return the array directly; the exact shape is noted per route.)

---

## Routes

### `GET /admin/transactions`

- **Auth:** `requireAdmin`
- **Mutating:** No
- **Query:** `limit` (default `50`, max `200`), `offset` (default `0`)
- **Response:** `{ items: Transaction[], limit, offset }`

Lists recent transactions via `listTransactions({ limit, offset })`.

---

### `GET /admin/workers`

- **Auth:** `requireAdmin`
- **Mutating:** No
- **Query:** `limit` (default `50`, max `200`), `offset` (default `0`)
- **Response:** `{ items: Worker[], limit, offset }`

Lists registered workers.

---

### `GET /admin/payers`

- **Auth:** `requireAdmin`
- **Mutating:** No
- **Query:** `limit` (default `50`, max `200`), `offset` (default `0`)
- **Response:** `{ items: Payer[], limit, offset }`

Lists registered payers.

---

### `GET /admin/treasury`

- **Auth:** `requireAdmin`
- **Mutating:** No
- **Query:** none
- **Response:** `{ balance, ... }` — current treasury snapshot.

---

### `GET /admin/fees`

- **Auth:** `requireAdmin`
- **Mutating:** No
- **Query:** `limit` (default `50`, max `200`), `offset` (default `0`)
- **Response:** `{ items: FeeRecord[], limit, offset }`

Lists collected fee records.

---

### `GET /admin/payouts`

- **Auth:** `requireAdmin`
- **Mutating:** No
- **Query:** `limit` (default `50`, max `200`), `offset` (default `0`)
- **Response:** `{ items: Payout[], limit, offset }`

Lists payout records.

---

### `GET /admin/kyc`

- **Auth:** `requireAdmin`
- **Mutating:** No
- **Query:** `limit` (default `50`, max `200`), `offset` (default `0`)
- **Response:** `{ items: KycRecord[], limit, offset }`

Lists KYC submissions.

---

### `GET /admin/referrals`

- **Auth:** `requireAdmin`
- **Mutating:** No
- **Query:** `limit` (default `50`, max `200`), `offset` (default `0`)
- **Response:** `{ items: Referral[], limit, offset }`

Lists referral relationships.

---

### `GET /admin/referral-earnings`

- **Auth:** `requireAdmin`
- **Mutating:** No
- **Query:** `limit` (default `50`, max `200`), `offset` (default `0`)
- **Response:** `{ items: ReferralEarning[], limit, offset }`

Lists referral earnings.

---

### `GET /admin/read-replica`

- **Auth:** `requireAdmin`
- **Mutating:** No
- **Query:** none
- **Response:** `{ status, lagSeconds, ... }` — read-replica health snapshot.

---

### `GET /admin/collusion`

- **Auth:** `requireAdmin`
- **Mutating:** No
- **Query:** `limit` (default `100`, max `500`), `offset` (default `0`)
- **Response:** `{ items: CollusionFlag[], limit, offset }`

Lists collusion flags. Note the different pagination bounds from the other
listing routes.

---

### `GET /admin/collusion/workers/:workerId`

- **Auth:** `requireAdmin`
- **Mutating:** No
- **Path params:** `workerId` — worker identifier
- **Query:** none
- **Response:** `{ workerId, flags: CollusionFlag[], ... }`

Returns collusion details for a single worker.

---

### `GET /admin/maintenance-windows`

- **Auth:** `requireAdmin`
- **Mutating:** No
- **Query:** none
- **Response:** `{ items: MaintenanceWindow[] }`

Lists scheduled maintenance windows. Backed by
[`src/maintenanceWindows.js`](../../src/maintenanceWindows.js).

---

### `POST /admin/maintenance-windows`

- **Auth:** `requireAdmin`
- **Mutating:** **Yes** — creates a maintenance window.
- **Body:** `{ startsAt, endsAt, reason? }` (ISO-8601 timestamps)
- **Response:** `{ window: MaintenanceWindow }` (the created window)

Schedules a new maintenance window. Backed by
[`src/maintenanceWindows.js`](../../src/maintenanceWindows.js).

---

### `DELETE /admin/maintenance-windows/:id`

- **Auth:** `requireAdmin`
- **Mutating:** **Yes** — removes a maintenance window.
- **Path params:** `id` — maintenance window identifier
- **Response:** `{ deleted: true }` on success; `404` if not found.

---

### `POST /admin/collusion/clear`

- **Auth:** `requireAdmin`
- **Mutating:** **Yes** — clears collusion flags.
- **Body:** `{ workerId? }` — when omitted, clears all flags.
- **Response:** `{ cleared: number }`

---

### `POST /admin/recovery/sweep`

- **Auth:** `requireAdmin`
- **Mutating:** **Yes**, unless `dryRun=true`.
- **Query:** `dryRun` — when `true`, reports what *would* be swept without
  mutating state.
- **Response:** `{ swept: number, dryRun: boolean, ... }`

Runs the recovery sweep. With `dryRun=true` this is effectively read-only.

---

## Fault-injection routes

The fault-injection routes are mounted via `mountFaultRoutes` and are also
gated by `requireAdmin`. They exist to exercise failure paths in staging and
should not be used in production.

| Method | Path | Mutating | Description |
| --- | --- | --- | --- |
| `POST` | `/admin/faults` | **Yes** | Arms a fault (body describes the fault to inject). |
| `GET` | `/admin/faults` | No | Lists currently armed faults. |
| `DELETE` | `/admin/faults/:id` | **Yes** | Disarms a single fault by id. |
| `DELETE` | `/admin/faults` | **Yes** | Disarms all faults. |

All fault-injection routes share the same auth model as the rest of `/admin`
(`503` when `ADMIN_TOKEN` is unset, `401` unauthorized, `403` forbidden).

---

## See also

- [`src/adminAuth.js`](../../src/adminAuth.js) — `requireAdmin` middleware and
  token/role/TOTP checks.
- [`src/maintenanceWindows.js`](../../src/maintenanceWindows.js) — maintenance
  window storage and scheduling.
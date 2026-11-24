# Web Push API

Web Push lets a worker receive a system notification for a matching question even when the console tab isn't open. It **supplements** SSE dispatch and never replaces it — see `src/push.js` for the rationale. If a worker has an active SSE stream, push is redundant but harmless.

Push is configured entirely through VAPID settings (see [Configuration](#configuration)). When those are unset, push is disabled and the subscribe/unsubscribe routes return `503`.

## Configuration

| Setting | Description |
| --- | --- |
| `VAPID_PUBLIC_KEY` | VAPID public key, served to clients via `GET /push/vapid-public-key`. |
| `VAPID_PRIVATE_KEY` | VAPID private key, used server-side to sign push messages. Never exposed. |
| `VAPID_SUBJECT` | Contact URI (e.g. `mailto:ops@example.com`) included in the VAPID JWT. |
| `PUSH_MIN_TIMEOUT_MS` | Minimum quorum window (in milliseconds) for a question to be eligible for push. Defaults to `20000`. |

If `VAPID_PUBLIC_KEY` or `VAPID_PRIVATE_KEY` is unset, push is disabled: `GET /push/vapid-public-key` returns `503`, and subscribe/unsubscribe return `503`.

## Authentication

All worker-scoped routes require a session token for the worker address in the path. Supply it as a bearer token:

```
Authorization: Bearer <token>
```

A token that is missing, malformed, or not valid for the `:address` in the path is rejected with `401`.

## `GET /push/vapid-public-key`

Returns the VAPID public key the client needs to create a `PushSubscription`, plus whether push is configured.

This route does not require authentication.

### Response `200`

```json
{
  "publicKey": "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
  "configured": true
}
```

### Errors

| Status | Body | When |
| --- | --- | --- |
| `503` | `{ "error": "push notifications are not configured on this server" }` | VAPID keys are unset. |

## `POST /workers/:address/push-subscribe`

Registers (or replaces) a push subscription for the worker at `:address`.

### Request body

```json
{
  "token": "<session token>",
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/abcdef...",
    "expirationTime": null,
    "keys": {
      "p256dh": "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
      "auth": "tBHItJI5svbpez7KI4CCXg"
    }
  },
  "categories": ["governance", "security"]
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `token` | string | yes | Session token for the worker address. May also be supplied via the `Authorization` header. |
| `subscription` | object | yes | Standard browser `PushSubscription` JSON (see below). |
| `categories` | string[] | no | Categories to receive notifications for. Omitted or empty means **all** categories. |

`subscription` is the standard `PushSubscription.toJSON()` shape:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `endpoint` | string | yes | Push service endpoint URL. |
| `expirationTime` | number \| null | no | Subscription expiry, if the browser reports one. |
| `keys.p256dh` | string | yes | Client public key (base64url). |
| `keys.auth` | string | yes | Client auth secret (base64url). |

### Categories filter

`categories` restricts which questions trigger a push for this subscription. Matching is **case-insensitive** (e.g. `"Governance"` matches `governance`). An empty array or an omitted field means the subscription receives pushes for every category.

### Response `200`

```json
{ "ok": true }
```

### Errors

| Status | Body | When |
| --- | --- | --- |
| `400` | `{ "error": "..." }` | Missing/invalid `subscription`, missing `endpoint`, or missing `keys.p256dh` / `keys.auth`. |
| `401` | `{ "error": "..." }` | Missing or invalid session token for `:address`. |
| `503` | `{ "error": "push notifications are not configured on this server" }` | VAPID keys are unset. |

## `POST /workers/:address/push-unsubscribe`

Removes the push subscription for the worker at `:address`.

### Request body

```json
{
  "token": "<session token>"
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `token` | string | yes | Session token for the worker address. May also be supplied via the `Authorization` header. |

### Response `200`

```json
{ "ok": true }
```

### Errors

| Status | Body | When |
| --- | --- | --- |
| `400` | `{ "error": "..." }` | Missing `token` (when not supplied via header). |
| `401` | `{ "error": "..." }` | Missing or invalid session token for `:address`. |
| `503` | `{ "error": "push notifications are not configured on this server" }` | VAPID keys are unset. |

## Delivery semantics

- Push supplements SSE dispatch. Workers with an open SSE stream may still receive a push; clients should de-duplicate by question id.
- Questions whose quorum window is shorter than `PUSH_MIN_TIMEOUT_MS` (default `20000` ms) are skipped — there isn't enough time for a push to be useful.
- Only subscriptions whose `categories` filter matches the question's category (case-insensitive) receive the push. Subscriptions with no categories receive all pushes.
- Expired or rejected subscriptions (e.g. `404`/`410` from the push service) are pruned automatically.
# Worker Protocol

This document describes the protocol a worker client uses to receive questions and
submit answers. It covers the SSE dispatch channel (`GET /app/events`) and the
answer submission endpoint (`POST /app/answer`).

All routes are served by `src/server.js`; dispatch behaviour lives in
`src/dispatch.js`.

## Connecting: `GET /app/events`

Workers open a long-lived [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
stream to receive dispatched questions.

```
GET /app/events?worker=<address>&token=<session-token>&categories=<csv>
Accept: text/event-stream
```

### Query parameters

| Param        | Required | Description |
| ------------ | -------- | ----------- |
| `worker`     | yes      | The worker's Stellar address. Missing → `400`. |
| `token`      | conditional | Session token for `worker`. Required only when the address requires auth (see below). |
| `categories` | no       | Comma-separated list of categories the worker wants to receive. Omit to receive all categories. |

### Authentication

- If `worker` is missing the server responds `400`:
  ```json
  { "error": "worker query param is required" }
  ```
- If the address requires auth (`requiresAuth(workerId)` is true), a valid session
token for that address must be supplied as `token`. Otherwise the server responds
`401`:
  ```json
  { "error": "a valid session token for this address is required — see POST /workers/:address/session" }
  ```
  Obtain a token via `POST /workers/:address/session`.

## SSE events

Each event is sent as a standard SSE frame:

```
event: <name>
data: <json>

```

### `connected`

Sent immediately after the stream is established, confirming the worker is
registered for dispatch.

```
event: connected
data: {"worker":"GABC...XYZ","categories":["translation","code-review"]}
```

### `question`

Sent when a question is dispatched to this worker. The payload contains the
question id and the question body the worker must answer.

```
event: question
data: {"questionId":"42","question":"Is this translation accurate?","category":"translation","quorumSize":3}
```

### Keep-alive comments

The server periodically sends SSE comment lines to keep the connection alive and
to refresh the worker's presence entry. These are not events and should be
ignored by clients:

```
: keep-alive

```

## Reconnection

SSE clients should reconnect automatically when the stream drops (the browser
`EventSource` API does this by default). On reconnect, re-open `GET /app/events`
with the same `worker`, `token`, and `categories` parameters. Presence entries
expire after a short TTL, so a dropped connection is cleaned up automatically if
the client does not reconnect.

## Submitting answers: `POST /app/answer`

```
POST /app/answer
Content-Type: application/json

{
  "questionId": "42",
  "worker": "GABC...XYZ",
  "answer": "Yes, the translation is accurate."
}
```

### Responses

| Status | Meaning |
| ------ | ------- |
| `200`  | Answer accepted and recorded toward quorum. |
| `400`  | Malformed request (missing/invalid fields, or the answer was rejected by content screening). |
| `401`  | Missing or invalid session token for the worker address. |
| `409`  | The worker already answered this question, or the question is already settled. |

Example error body:

```json
{ "error": "worker has already answered this question" }
```

Answers are counted toward the question's quorum; once quorum is reached the
question is settled and further answers are rejected with `409`.

# Dispatch Fairness Threat Model

## Scope

This document models fairness attacks against the SSE-based question dispatch
path in `src/dispatch.js`. It covers the broadcast that notifies connected
workers of an open question, the response window in which workers may claim
that question, and the quorum logic that decides which worker is awarded the
work.

> **Review note (issue #318).** Checked against the current `src/dispatch.js`:
> the "Mitigation: randomized selection within an early-response window"
> section below describes a *proposed* design, not implemented behavior. No
> `FAIRNESS_WINDOW_MS` setting or response-window/random-winner selection
> exists anywhere in `src/`. What dispatch does today is route the broadcast
> through `selectTargets()`: optional private-pool `whitelist` (fails closed),
> category routing (fails open), a reputation eligibility filter (fails open),
> and `preferEstablished` (restricts to established workers only if at least
> `quorumSize` of them are online). A soft stake gate, `stakeGateAllows()`
> (`WORKER_MIN_STAKE_STROOPS`, default 0 = disabled), also exists, which the
> "out of scope" stake-based admission remark below does not mention. How the
> winner is chosen among responses was not re-audited here.

## Assets and actors

- **Asset:** the right to answer a question (and the payout/credit attached to
  it).
- **Honest worker:** a human or human-in-the-loop agent with realistic latency
  (hundreds of milliseconds to seconds) and bounded concurrency.
- **Bot cartel:** one or more automated clients with sub-millisecond network
  latency, effectively unlimited concurrency, and the ability to answer every
  broadcast instantly. Cartel members may share state so that only one of them
  needs to win for the cartel to profit.

## Threat: coordinated instant-response starvation

Today's dispatch is first-come-first-served (FCFS): the first response that
reaches quorum wins. Under FCFS the cartel's advantage is purely infrastructural
— whoever has the lowest latency wins every question. Because the cartel can
answer *every* broadcast, honest workers are starved out of the reward stream
entirely, even when they are willing and able to do the work. `preferEstablished`
mitigates this for the Priority tier only, and even established workers can run
the same instant-response strategy, so it is not a general defense.

### Attack variants

1. **Pure latency race.** Cartel answers within microseconds of every broadcast.
2. **Established-identity laundering.** Cartel builds reputation on a small set
   of accounts, then uses those accounts to bypass `preferEstablished`.
3. **Burst flooding.** Cartel opens many connections and answers each question
   from several identities to guarantee at least one wins.

## Why FCFS is inherently gameable

Any selection rule that is a strictly increasing function of response speed
rewards the fastest infrastructure. Since infrastructure speed is cheap to buy
and unbounded, FCFS makes bot operation strictly profitable and honest operation
strictly unprofitable. A real defense must make instant response *not* a
guaranteed win, so that the expected value of running a bot drops below the
cost of running it.

## Mitigation: randomized selection within an early-response window

Instead of awarding the question to the first responder, dispatch now:

1. Opens a short **fairness window** (`FAIRNESS_WINDOW_MS`, default 250 ms)
   after the broadcast during which responses are collected rather than
   immediately awarded.
2. At the end of the window, selects the winner **uniformly at random** among
   all responses received inside the window, optionally weighted by a
   reputation score when one is available.

This changes the economics of the attack: a cartel that answers instantly no
longer wins with probability 1. If the cartel submits `k` responses and honest
workers submit `h` responses inside the window, the cartel's expected share is
`k / (k + h)` rather than 1. To keep winning, the cartel must flood the window
with identities, which raises its cost and its detection surface. Honest workers
who respond anywhere inside the window have the same chance as an instant
responder, so latency stops being the deciding factor.

### Properties

- **Preserves existing behavior.** `preferEstablished`, the Priority tier, and
the SSE broadcast surface are unchanged; the fairness window only changes *how*
the winner is chosen among responses that already qualify.
- **Bounded latency cost.** The window is short and configurable; when no
  competing responses arrive, the question is awarded as soon as the window
  closes.
- **Reputation-aware.** When a reputation score is supplied, selection is
  weighted by it, so established honest workers retain an edge without making
  instant response a guaranteed win.

## Residual risk

A cartel that controls a large fraction of identities inside the window can
still capture a proportional share. The mitigation is designed to make that
share proportional to *cost* rather than to *latency*, which is the property
FCFS lacks. Further hardening (proof-of-effort, stake-based admission) is out
of scope for this change.

## Maintenance windows and dispatch pauses

Dispatch can be paused for scheduled maintenance or holidays. The pause is
enforced in `src/server.js` (see the `POST /oracle` handler and the
`GET /maintenance` route) and the window schedule lives in
`src/maintenanceWindows.js`. This section documents the client-facing contract;
it does not change any behavior.

### `GET /maintenance`

Public, like `GET /health`. Returns the dispatch pause currently in effect (if
any) and every scheduled maintenance/holiday window still ahead, so clients and
workers can plan around them.

Response fields:

- `dispatchPaused` (boolean): whether a dispatch pause is in effect right now.
- `reason` (string, optional): present only when `dispatchPaused` is `true`;
  human-readable reason for the pause.
- `resumesAt` (string, optional): present only when `dispatchPaused` is `true`;
  ISO 8601 timestamp at which dispatch is expected to resume.
- `windows` (array): upcoming maintenance/holiday windows, each serialized by
  `serializeWindow` in `src/maintenanceWindows.js`.

Example — no pause in effect:

```json
{
  "dispatchPaused": false,
  "windows": [
    {
      "id": "holiday-2025-12-25",
      "startsAt": "2025-12-25T00:00:00.000Z",
      "endsAt": "2025-12-25T23:59:59.000Z",
      "reason": "Holiday"
    }
  ]
}
```

Example — pause in effect:

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
HTTP `503 Service Unavailable` and a `Retry-After` header indicating how long
the client should wait before retrying.

Example rejection:

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 120
Content-Type: application/json

{
  "error": "dispatch paused",
  "reason": "Scheduled maintenance",
  "resumesAt": "2025-06-01T12:00:00.000Z"
}
```

### How clients should back off

1. On `503` from `POST /oracle`, honour the `Retry-After` header (seconds, or an
   HTTP date) instead of retrying immediately.
2. Optionally poll `GET /maintenance` to learn `dispatchPaused`, `reason`, and
   `resumesAt`, and to see upcoming `windows` so work can be scheduled around
   them.
3. Resume normal dispatch once `dispatchPaused` is `false` or `resumesAt` has
   passed.

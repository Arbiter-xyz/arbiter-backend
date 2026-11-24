# Teams API

The `/teams` routes let a Stellar address create and manage team (organization) accounts with role-based membership. Every route authenticates the caller with a Stellar `address` and a session `token` obtained from [`POST /payers/:address/session`](./sessions.md). Role checks (owner / admin / member) are enforced server-side.

> **Auth recap:** send `address` and `token` either in the JSON request body or in the query string. The token must be a valid, unexpired session token for that address. See [docs/api/sessions.md](./sessions.md) for how to obtain one.

## Roles

| Role | Description |
| --- | --- |
| `owner` | Created the team. Exactly one owner. Can rename, delete the team, and promote/demote members (including transferring ownership). |
| `admin` | Can rename the team, add members, remove members, and change member roles (except promoting/demoting to/from `owner`). |
| `member` | Read access. Can view the team and its combined question history, and may remove themselves. |

## Limits

| Constant | Value | Meaning |
| --- | --- | --- |
| `MAX_TEAM_MEMBERS` | `100` | Maximum members per team. |
| `MAX_TEAMS_PER_ADDRESS` | `20` | Maximum teams a single address may belong to. |
| `MAX_TEAM_NAME_LENGTH` | `80` | Maximum length of a team name (characters). |

All member addresses must be valid Stellar addresses (a `G...` public key). Invalid addresses are rejected with `400`.

## Error mapping

Team operations raise a `TeamError` that is mapped to an HTTP status:

| Status | Meaning |
| --- | --- |
| `400` | Validation error — missing/invalid fields, invalid Stellar address, name too long, limit exceeded, etc. |
| `401` | Missing or invalid session `address`/`token`. |
| `403` | Authenticated but the caller's role is insufficient for the operation. |
| `404` | Unknown team (or the caller is not a member of it). |
| `409` | Conflict — e.g. the owner trying to leave without transferring ownership first. |

Error responses have the shape:

```json
{ "error": "human readable message" }
```

---

## Create a team

`POST /teams`

Creates a new team with the caller as its `owner`. Fails with `400` if the caller already belongs to `MAX_TEAMS_PER_ADDRESS` teams, or if `name` is missing or longer than `MAX_TEAM_NAME_LENGTH`.

**Auth:** `address` + `token` (required)

**Role:** any authenticated address

**Request body:**

```json
{
  "address": "G...CALLER",
  "token": "session-token",
  "name": "Acme Research"
}
```

**Response `201`:**

```json
{
  "team": {
    "id": "team_123",
    "name": "Acme Research",
    "owner": "G...CALLER",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "members": [
      { "address": "G...CALLER", "role": "owner" }
    ]
  }
}
```

**curl:**

```bash
curl -X POST https://api.example.com/teams \
  -H 'Content-Type: application/json' \
  -d '{"address":"G...CALLER","token":"session-token","name":"Acme Research"}'
```

---

## List teams

`GET /teams`

Lists every team the caller belongs to (as owner, admin, or member).

**Auth:** `address` + `token` (required; may be sent as query params)

**Role:** any authenticated address

**Query params:**

| Param | Required | Description |
| --- | --- | --- |
| `address` | yes | Caller's Stellar address. |
| `token` | yes | Session token for `address`. |

**Response `200`:**

```json
{
  "teams": [
    {
      "id": "team_123",
      "name": "Acme Research",
      "owner": "G...CALLER",
      "role": "owner",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

**curl:**

```bash
curl 'https://api.example.com/teams?address=G...CALLER&token=session-token'
```

---

## Get a team

`GET /teams/:teamId`

Returns a single team, including its members and their roles.

**Auth:** `address` + `token` (required)

**Role:** `member` or higher (must belong to the team)

**Response `200`:**

```json
{
  "team": {
    "id": "team_123",
    "name": "Acme Research",
    "owner": "G...CALLER",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "members": [
      { "address": "G...CALLER", "role": "owner" },
      { "address": "G...MEMBER", "role": "member" }
    ]
  }
}
```

**curl:**

```bash
curl 'https://api.example.com/teams/team_123?address=G...CALLER&token=session-token'
```

---

## Rename a team

`PATCH /teams/:teamId`

Renames the team. `name` must be non-empty and at most `MAX_TEAM_NAME_LENGTH` characters.

**Auth:** `address` + `token` (required)

**Role:** `admin` or `owner`

**Request body:**

```json
{
  "address": "G...CALLER",
  "token": "session-token",
  "name": "Acme Research (Renamed)"
}
```

**Response `200`:**

```json
{
  "team": {
    "id": "team_123",
    "name": "Acme Research (Renamed)",
    "owner": "G...CALLER",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**curl:**

```bash
curl -X PATCH https://api.example.com/teams/team_123 \
  -H 'Content-Type: application/json' \
  -d '{"address":"G...CALLER","token":"session-token","name":"Acme Research (Renamed)"}'
```

---

## Delete a team

`DELETE /teams/:teamId`

Deletes the team and all its memberships.

**Auth:** `address` + `token` (required)

**Role:** `owner` only

**Request body (or query params):**

```json
{
  "address": "G...CALLER",
  "token": "session-token"
}
```

**Response `200`:**

```json
{ "deleted": true, "id": "team_123" }
```

**curl:**

```bash
curl -X DELETE https://api.example.com/teams/team_123 \
  -H 'Content-Type: application/json' \
  -d '{"address":"G...CALLER","token":"session-token"}'
```

---

## Add a member

`POST /teams/:teamId/members`

Adds a member to the team with the given role. The member address must be a valid Stellar address. Fails with `400` if the team already has `MAX_TEAM_MEMBERS` members, and with `409` if the address is already a member.

**Auth:** `address` + `token` (required)

**Role:** `admin` or `owner`

**Request body:**

```json
{
  "address": "G...CALLER",
  "token": "session-token",
  "member": "G...NEWMEMBER",
  "role": "member"
}
```

`role` is one of `admin` or `member` (use the update route to transfer ownership).

**Response `201`:**

```json
{
  "member": { "address": "G...NEWMEMBER", "role": "member" }
}
```

**curl:**

```bash
curl -X POST https://api.example.com/teams/team_123/members \
  -H 'Content-Type: application/json' \
  -d '{"address":"G...CALLER","token":"session-token","member":"G...NEWMEMBER","role":"member"}'
```

---

## Update a member's role

`PATCH /teams/:teamId/members/:address`

Changes a member's role. Promoting to or demoting from `owner` (ownership transfer) is restricted to the current `owner`.

**Auth:** `address` + `token` (required)

**Role:** `admin` or `owner`; promoting/demoting `owner` requires `owner`

**Path param:** `:address` — the member whose role is being changed.

**Request body:**

```json
{
  "address": "G...CALLER",
  "token": "session-token",
  "role": "admin"
}
```

`role` is one of `owner`, `admin`, or `member`.

**Response `200`:**

```json
{
  "member": { "address": "G...MEMBER", "role": "admin" }
}
```

**curl:**

```bash
curl -X PATCH https://api.example.com/teams/team_123/members/G...MEMBER \
  -H 'Content-Type: application/json' \
  -d '{"address":"G...CALLER","token":"session-token","role":"admin"}'
```

---

## Remove a member

`DELETE /teams/:teamId/members/:address`

Removes a member from the team. A member may remove themselves (leave) without admin rights. The `owner` cannot leave without first transferring ownership — attempting to do so returns `409`.

**Auth:** `address` + `token` (required)

**Role:** `admin` or `owner`; a `member` may remove only themselves

**Path param:** `:address` — the member to remove.

**Request body (or query params):**

```json
{
  "address": "G...CALLER",
  "token": "session-token"
}
```

**Response `200`:**

```json
{ "removed": true, "address": "G...MEMBER" }
```

**curl:**

```bash
curl -X DELETE https://api.example.com/teams/team_123/members/G...MEMBER \
  -H 'Content-Type: application/json' \
  -d '{"address":"G...CALLER","token":"session-token"}'
```

---

## Combined question history

`GET /teams/:teamId/questions`

Returns the combined question history for all members of the team, aggregated across the team's addresses.

**Auth:** `address` + `token` (required)

**Role:** `member` or higher (must belong to the team)

**Query params:**

| Param | Required | Description |
| --- | --- | --- |
| `address` | yes | Caller's Stellar address. |
| `token` | yes | Session token for `address`. |

**Response `200`:**

```json
{
  "questions": [
    {
      "id": "q_456",
      "asker": "G...MEMBER",
      "question": "What is the meaning of life?",
      "createdAt": "2024-01-02T00:00:00.000Z"
    }
  ]
}
```

**curl:**

```bash
curl 'https://api.example.com/teams/team_123/questions?address=G...CALLER&token=session-token'
```

---

## See also

- [Sessions API](./sessions.md) — how to obtain the `address` + `token` used by every route above.
- [Webhooks API](./webhooks.md) — the payer side uses the same `address` + `token` authentication scheme.
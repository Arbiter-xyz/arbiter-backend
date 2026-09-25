# @arbiter-xyz/mcp-server

An [MCP](https://modelcontextprotocol.io) server that exposes **Arbiter** — the
pay-per-question human-intelligence oracle — as tools any MCP host (Claude
Desktop, Claude Code, …) can call. An agent gets one coherent "ask and get an
answer" tool; it never sees the async job/poll mechanics or HTTP semantics.

## Tools

| Tool | What it does | Backend call |
| --- | --- | --- |
| `arbiter_ask` | Submit a question and (by default) wait for the settled answer. | `POST /oracle` (API-key billing) or `POST /oracle/sandbox`, then `GET /oracle/:jobId` |
| `arbiter_get_job` | Fetch/wait for a job's result by `jobId`. | `GET /oracle/:jobId` |
| `arbiter_leaderboard` | Read-only worker leaderboard. | `GET /leaderboard` |
| `arbiter_stats` | Read-only platform counters. | `GET /stats` |

`arbiter_ask` takes `question`, optional `tier` (`instant`, `standard`,
`express`, `priority`, `auto`), `category`, `wait` (default `true`) and
`timeoutSeconds` (default 60, max 300). The wait is a **bounded** poll loop: if
the answer isn't ready in time the tool returns the current status and the
`jobId`, and the agent can call `arbiter_get_job` again.

### Payment

The server is for the payer/consumer side and holds no Stellar wallet:

- **API key** (`ARBITER_API_KEY=ak_live_...`) — the wallet-free path. The
  backend charges the key's fiat credit and replies `202` directly, so there is
  no 402 round trip to handle. An out-of-credit `402` comes back as a tool
  error. (A key is issued by the backend's Stripe checkout flow,
  `POST /billing/checkout`.)
- **Sandbox** (`ARBITER_SANDBOX=true`) — free, simulated, no key. Every result
  is tagged `SANDBOX: simulated result, not a real human answer` so an agent
  can't mistake it for a real answer.
- With neither set, `arbiter_ask` refuses to run and says why. If the backend
  ever answers with a raw on-chain 402 challenge, that also surfaces as a tool
  error, since paying it needs a wallet.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARBITER_BASE_URL` | `http://localhost:4000` | Arbiter backend URL |
| `ARBITER_API_KEY` | – | `ak_live_...` key for real questions |
| `ARBITER_SANDBOX` | `false` | Use the free simulated sandbox instead |
| `ARBITER_POLL_INTERVAL_MS` | `2000` | Poll interval while waiting |
| `ARBITER_MAX_WAIT_MS` | `60000` | Default max wait per call (hard cap 300000) |

## Install

```sh
npm install -g @arbiter-xyz/mcp-server   # or run it with npx, below
```

### Claude Desktop

Add to `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "arbiter": {
      "command": "npx",
      "args": ["-y", "@arbiter-xyz/mcp-server"],
      "env": {
        "ARBITER_BASE_URL": "https://your-arbiter-backend.example.com",
        "ARBITER_API_KEY": "ak_live_..."
      }
    }
  }
}
```

For a no-key trial, replace `ARBITER_API_KEY` with `"ARBITER_SANDBOX": "true"`.
Restart Claude Desktop; "arbiter" appears in the tools list.

### Claude Code

```sh
claude mcp add arbiter --env ARBITER_BASE_URL=https://your-arbiter-backend.example.com \
  --env ARBITER_API_KEY=ak_live_... -- npx -y @arbiter-xyz/mcp-server
```

## Development

```sh
npm install
npm test        # mocked-HTTP tests for every tool's call mapping
npm start       # speaks MCP over stdio (logs go to stderr)
```

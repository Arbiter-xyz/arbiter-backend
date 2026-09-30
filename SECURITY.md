# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Report privately through either channel:

- **GitHub Security Advisories** — use the ["Report a vulnerability"](https://github.com/Arbiter-xyz/arbiter-backend/security/advisories/new)
  button on this repository's **Security** tab (preferred: it keeps the
  report, discussion and fix private until a coordinated disclosure).
- **Email** — `security@arbiter.xyz`.

Please include enough to reproduce: affected endpoint or module, the
request/response or transaction involved, and the impact you believe it
has. If you have a proof of concept, attach it.

## What's in scope

This repository — the Arbiter backend — is the security-sensitive surface.
In particular:

- The three key roles this service custodies: `PLATFORM_SECRET` (fee
  revenue and settlement authority), `FIAT_POOL_SECRET` (the pooled
  fiat-onramp balance), and `ADMIN_TOKEN` (read access to the ops console).
- Worker and payer authentication: worker session auth (`workerAuth.js`),
  payer session tokens, and API-key auth (`Authorization: Bearer ak_...`).
- The payment/settlement flow (`/oracle`, `billing.js`, webhook signing and
  delivery) and the admin/ops console (`/admin/*`).

Out of scope: the on-chain contract itself (report to
[arbiter-contract](https://github.com/Arbiter-xyz/arbiter-contract)), the
client SDKs' non-security bugs, and findings that require a compromised
host or already-leaked secret.

## Deployment status

This is presently a **testnet-only** deployment. It is production-shaped
and custodies real value in the sense that the flows are live, but the
keys and funds involved are testnet — please calibrate severity
accordingly. We would still rather hear about an issue early than read it
in a public issue.

## What to expect

We aim to acknowledge a report within **3 business days** and to give an
initial assessment (in scope / severity / rough timeline) within **7
business days**. We'll keep you updated as we work on a fix and are happy
to credit you in the advisory unless you'd prefer otherwise.

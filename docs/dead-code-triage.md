# Uncalled-export triage (#221)

Every export from #221's list, with the decision taken and why. "Wired" means it now has a real
route or caller, covered by `test/opsRoutes.test.js` (routes) or `test/deployment.test.js`
(drain). "Deleted" code can be recovered from git history at the parent of the commit that
removed it.

Before triaging, seven source files were restored from git history. A tool had truncated each one
mid-file, leaving a literal `/* … truncated N chars … */` marker where the rest should be:
`admin.js`, `collusion.js`, `consensus.js`, `gamification.js`, `jobs.js`, `taxReport.js` and
`teams.js`. An eighth, `dispatch.js`, is still open (see the end of this document). `store.js`'s
`export const store`, deleted by #86 and imported by about 25 modules, was restored too. Several "uncalled"
names could have had callers in the lost tails, so the triage was run against the restored files.

## Wired up

| Export | Decision |
| --- | --- |
| `maintenanceWindows.addWindow`, `removeWindow` | **Wired.** `POST /admin/maintenance-windows` and `DELETE /admin/maintenance-windows/:id` shipped with the feature (`c069932`) and were dropped by a later merge. Restored as `mountMaintenanceRoutes()`. |
| `taxReport.buildAllTaxSummaries`, `taxSummariesToCsv` | **Wired.** `GET /admin/tax/summaries?year=&usOnly=&reportableOnly=&format=csv`. This also restored `config.tax`, which `1db621e` had dropped and without which every tax summary, per-worker included, threw. |
| `payerIndex.erasePayerRecords`, `anchorRecords.eraseAnchorRecords` | **Wired.** `DELETE /admin/erasure/:address` (`src/erasure.js`). The response states that on-chain records are not erased. `eraseAnchorRecords` called a non-existent `store.del()`; it now uses `store.delete()` and reports what it removed. |
| `support.createTicket`, `listTickets`, `getTicket`, `respondToTicket` | **Wired.** `POST /support/tickets` (session-authenticated, rate-limited), plus `GET /admin/support/tickets[/:id]` and `POST /admin/support/tickets/:id/respond`. The module could not load before: it imported a non-existent `auditLog.js`, called `verifySessionToken(address, token)` (it takes only the token), and kept tickets in a process-local `Map`. It now persists via `store` and authenticates with `verifySession()`. |
| `autoWithdraw.stopAutoWithdrawSweep` | **Wired.** Runs at the start of every blue-green drain (#90); `startAutoWithdrawSweep` runs on resume. |
| `dispatch.refreshPresence` | **Wired.** Called on every SSE keep-alive, as its doc comment says. Without it, a worker's cross-instance presence record expired `PRESENCE_TTL_SECONDS` after connecting. |
| `adminAuth.requireMetricsAuth` | **Deleted** (#222). It was an alias of `requireAdmin`. Wiring it in would have closed `/metrics` by default, which #222 rules out of scope, and would have handed the scraper the admin token. `metricsHandler`'s own `METRICS_TOKEN` check is the gate, and `securityPosture.js` now warns when it's unset in production. |

## Deleted

| Export(s) | Why |
| --- | --- |
| `jobs.getPendingReviews`, `escalateItem`, `getEscalatedIds`, `markPendingReview` (and the rest of the review/escalation queue: `approveReview`, `getPendingReviewJobIds`, `unescalateItem`, `getEscalatedItems`, the index helpers and keys) | Nothing ever puts a job *into* review: no settlement path calls `markPendingReview`, so a route would list an always-empty queue. Deciding when a job needs human review is a product decision, not wiring. `markPendingReview` also referenced an undefined `outcome`, left by the merge in `cca8b2b`. |
| `jobs.markSynthetic`, `getSyntheticJobIds`, `isSyntheticJob` | The synthetic-monitoring runner (#111) they serve doesn't exist. |
| `consensus.postmortemFallback`, `normalizePostmortemDraft`, `buildPostmortemPrompt`, `REPORT_POSTMORTEM_TOOL`; `admin.generatePostmortem`, `selectIncidentLogs`, `REPORT_POSTMORTEM_TOOL`; `logger.recordLogLine`, `getLogSlice`, `clearLogBuffer`, `recordRequestContext` | Three disconnected half-implementations of the postmortem generator (#109). The log buffer it would read was never written to, and `generatePostmortem` imported a `getClient` that `reconcile.js` doesn't export. Rebuilding it means picking one design. |
| `pendingQuestions.pickContractInstance`, `getStashedContractInstance` (and `getContractInstances`) | Multi-contract sharding (#138) was never adopted: every admin call still targets `config.contractId`. |
| `stellarClient.rotateContractIdAfterDrain`, `refundQuestionsBatch`, `getTimeoutLedgersOnChain` | No caller, no test. The batch variant assumes a `refund_batch` contract method nothing here confirms exists. |
| `pricing.MIN_VOLUME_DISCOUNT_MULTIPLIER`, `priceForTierWithVolumeDiscount` (and `volumeDiscountMultiplier`, `VOLUME_DISCOUNT_TIERS`) | Every real price comes from `priceForTier`. |
| `admin.provisionAccount`, `adminAuth.createInvoiceBilledAccount` | Two competing implementations of invoice-billed provisioning (#106) that credit in different units (USDC vs raw credits). `provisionAccount` also referenced an undefined `createAccount` and `store`. Picking one is a product decision. |
| `admin.unsuspendKey` | Delegates to an `unsuspendAccount` that exists nowhere. |
| `billing.getApplePayVerificationOrigin` | A helper that "exists to be testable", with no test and no caller. |
| `billing.refreshFiatPoolBalanceMetric` (and `getFiatPoolBalanceStroops`) | Reads the `pool:<address>` store key, which nothing writes, and sets a gauge that was never defined. Wiring it would have published a made-up `0` balance. `admin.getTreasury()` already reads the real on-chain balance. |
| `payerIndex.payerOwnsQuestion`, `claimLoyaltyTier`, `listPayerLoyaltyTiers` | The dispute route (#124) and loyalty crediting don't exist; `admin.listPayers()` already shows each payer's loyalty tier. |
| `anchorClient.clearAnchorConfigCache` | No caller, including tests. |
| `leaderboard.getLeaderboardV2` (and `toLeaderboardV2`) | There is no API-version negotiation for it to plug into. |
| `pubsub.getPubSub` (the whole `pubsub.js`) | Nothing imports the module. `dispatch.js` coordinates through `store.getClient()` directly. |
| `rateLimit.claudeBudgetRemaining` | No caller. |
| `dispatch.recordSettlement` | The settlement paths never call it, and it routed through `touchWorker` (a contract TTL call), not settlement tracing. |
| `stats.emptyStats`, `applyShadowAgreement`, `publicStats`, `getUsage` (and `recordUsage`, `usageKey`) | The shadow-mode counters are never fed. `getUsage` called `store.listKeys()`, which neither store implements. |

## Still open (outside this list)

- `dispatch.js` still ends in a truncation marker. `dispatchAndCollect`, `getSmoothedOnlineWorkerCount`
  and the other names `oracle.js` and the dispatch tests import have been missing since `e626336`
  (#3), and the file has since been redesigned around `registerCollector`. Restoring them is a
  dispatch redesign, not a mechanical restore. It is recorded in `eslint-suppressions.json`.
- `server.js` mounts every pre-existing `/admin/*` route with `requireAdmin`, the factory, instead of
  `requireAdmin()`. Express calls the factory as middleware, it never calls `next()` or responds,
  and those requests hang. The routes added here use `requireAdmin()`. Fixing the existing ones
  changes every admin route, so it's left for its own PR.

const express = require('express');
const helmet = require('helmet');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const app = express();

// Soroban contract error code for `ContractError::InsufficientBalance`.
//
// LOUD WARNING: this number is part of arbiter-contract's external interface.
// `#[repr(u32)]` values are matched numerically by clients, so a renumbering
// event breaks this mapping SILENTLY — no build error on either side. This has
// already happened once: arbiter-contract's docs/versioning.md "Class D"
// records `QuorumTooLarge` being renumbered to 200 after two branches' error
// codes collided on merge (clients built against the earlier version would
// misread 15–18). See also arbiter-contract PR #180, which removed 6
// `ContractError` variants to fit Soroban's 50-variant XDR cap.
//
// Source of truth: repo-root `src/lib.rs` in arbiter-contract (NOT
// `contracts/oracle-escrow/src/lib.rs`, which is docs-only). If that enum
// changes, update this constant deliberately — see issue #236.
const INSUFFICIENT_BALANCE_CODE = 13;
const INSUFFICIENT_BALANCE_RE = new RegExp(
  `Error\\(Contract, #${INSUFFICIENT_BALANCE_CODE}\\)`
);

// Security headers: CSP, X-Frame-Options (frame-ancestors), nosniff, etc.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// Rebuild the in-process push subscribed-workers index from durable store
// records on startup, so getPushEligibleWorkerIds() works before any worker
// re-calls the subscribe endpoint after a restart.
const { rebuildSubscribedWorkers } = require('./push');

// Dedicated rate limit for the sponsor onboarding route. Each call to
// buildSponsoredOnboardTx (src/sponsor.js) spends a real sponsored-reserve
// transaction, so it must not share the generic 'sponsor' bucket used by
// cheaper sponsor endpoints. This is intentionally stricter than the generic
// wrapper: a small per-IP window caps how much reserve a single client can
// burn even if the generic limiter is loosened elsewhere.
const SPONSOR_ONBOARD_WINDOW_MS = 60 * 1000;
const SPONSOR_ONBOARD_MAX = 5;
const sponsorOnboardHits = new Map();

function rateLimitedSponsorOnboard(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.connection?.remoteAddress || 'unknown';
  const entry = sponsorOnboardHits.get(key);
  if (!entry || now - entry.start >= SPONSOR_ONBOARD_WINDOW_MS) {
    sponsorOnboardHits.set(key, { start: now, count: 1 });
    return next();
  }
  if (entry.count >= SPONSOR_ONBOARD_MAX) {
    res.set('Retry-After', String(Math.ceil((entry.start + SPONSOR_ONBOARD_WINDOW_MS - now) / 1000)));
    return res.status(429).json({ error: 'Too many sponsor onboarding requests' });
  }
  entry.count += 1;
  return next();
}

app.use('/api/sponsor/onboard', rateLimitedSponsorOnboard);

// Cancel a pending question within its undo window. This is the canonical
// route advertised by oracle.js/metered.js as `cancelUrl: /oracle/${jobId}/cancel`
// and it delegates to the existing cancelJob() implementation rather than
// reimplementing cancellation logic here.
app.post('/oracle/:jobId/cancel', async (req, res) => {
  try {
    const { cancelJob } = require('./oracle');
    const result = await cancelJob(req.params.jobId);
    if (result && result.error) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('Failed to cancel job:', err);
    return res.status(500).json({ error: 'Failed to cancel job' });
  }
});

async function start() {
  await rebuildSubscribedWorkers();
  const port = process.env.PORT || 3000;
  const server = http.createServer(app);
  attachWebSocketServer(server);
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });

  // Start the gRPC interface alongside Express in the same process. It binds
  // to its own port (GRPC_PORT, default 50051) so there are no port or route
  // conflicts, and shares oracle.js's business logic rather than duplicating it.
  try {
    const oracle = require('./oracle');
    const { startGrpcServer } = require('./grpc-server');
    await startGrpcServer(oracle);
  } catch (err) {
    console.error('Failed to start gRPC server:', err);
  }
}

if (require.main === module) {
  start();
}

module.exports = app;
module.exports.start = start;
module.exports.attachWebSocketServer = attachWebSocketServer;
module.exports.INSUFFICIENT_BALANCE_CODE = INSUFFICIENT_BALANCE_CODE;
module.exports.INSUFFICIENT_BALANCE_RE = INSUFFICIENT_BALANCE_RE;

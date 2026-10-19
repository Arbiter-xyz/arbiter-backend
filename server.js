const express = require('express');
const helmet = require('helmet');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const app = express();

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

async function start() {
  // Rebuild the push subscribed-workers index from durable store records so
  // push-eligible worker indexes are populated immediately after a restart,
  // rather than staying empty until each worker resubscribes. Guarded so a
  // push store/DB failure (or push being disabled/unconfigured) cannot crash
  // boot; the index will simply repopulate as workers resubscribe.
  try {
    await rebuildSubscribedWorkers();
  } catch (err) {
    console.error('Failed to rebuild subscribed workers on startup:', err);
  }

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

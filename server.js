const express = require('express');
const helmet = require('helmet');
const path = require('path');
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

app.use(express.static(path.join(__dirname, 'dist')));

// Rebuild the in-process push subscribed-workers index from durable store
// records on startup, so getPushEligibleWorkerIds() works before any worker
// re-calls the subscribe endpoint after a restart.
const { rebuildSubscribedWorkers } = require('./push');

async function start() {
  await rebuildSubscribedWorkers();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = app;
module.exports.start = start;

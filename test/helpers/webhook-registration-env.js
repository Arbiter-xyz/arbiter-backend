// Must be the FIRST import (see sponsor-test-env.js). Registration tests
// keep production URL validation (no insecure targets) and exercise
// at-rest encryption of signing secrets and a small per-owner cap.
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'registration-test-key';
process.env.WEBHOOK_MAX_PER_OWNER = '3';

// Same hoisting concern documented in sponsor-test-env.js: must be the
// FIRST import in any test file that needs non-default config.webhooks.*,
// since config.js freezes its values at import time.
//
// Local receivers in these tests listen on 127.0.0.1 over plain http, which
// production validation rightly rejects, so insecure targets are allowed
// here. Backoff is shrunk so retry tests finish in milliseconds.
process.env.WEBHOOK_ALLOW_INSECURE_TARGETS = 'true';
process.env.WEBHOOK_RETRY_BASE_DELAY_MS = '25';
process.env.WEBHOOK_MAX_ATTEMPTS = '3';
process.env.WEBHOOK_TIMEOUT_MS = '1000';
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = 'test-webhook-encryption-key';
// Settlement end-to-end tests drive the instant tier fully offline: no LLM
// key means no draft answer, and no platform secret means refund() fails
// fast, so the job settles as refund_pending_timeout without any network.
process.env.ANTHROPIC_API_KEY = '';
process.env.PLATFORM_SECRET = '';

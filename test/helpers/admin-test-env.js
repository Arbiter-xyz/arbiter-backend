// Same hoisting concern documented in sponsor-test-env.js: must be the
// FIRST import in any test file that needs a non-default config.admin.token,
// since config.js freezes its values at import time.
process.env.ADMIN_TOKEN = 'test-admin-token';

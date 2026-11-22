// Same hoisting concern documented in sponsor-test-env.js: must be the
// FIRST import in any test file that needs a non-default config.admin.token,
// since config.js freezes its values at import time.
process.env.ADMIN_TOKEN = 'test-admin-token';
// Extra independently-revocable tokens (#24), exercised by adminAuth.test.js.
process.env.ADMIN_TOKENS = 'tokenA,tokenB';

// Same hoisting concern documented in sponsor-test-env.js: must be the
// FIRST import in any test file that needs a non-default config.billing.*.
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
process.env.FIAT_POOL_ADDRESS = 'GDPOOLTESTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
process.env.FIAT_POOL_SECRET = 'SPOOLTESTSECRETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

// Same hoisting concern documented in sponsor-test-env.js: must be the
// FIRST import in any test file that needs a short undo window, since
// config.undoWindowMs is read once at load time.
process.env.UNDO_WINDOW_MS = '200';

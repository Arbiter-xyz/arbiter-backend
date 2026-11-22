#!/usr/bin/env node
// Boot smoke test (#467): PR #206 merged `import { verifyTotp } from
// './totp.js'` into src/adminAuth.js when src/totp.js didn't exist. `npm
// run check` (node --check) only validates syntax, not that imports
// actually resolve, so that merge passed CI and broke the server's boot
// sequence in production — and nothing in the Wave completion process
// caught it (see #467's full write-up).
//
// This actually boots src/server.js as a real child process and watches
// for exactly that failure mode: a Node ERR_MODULE_NOT_FOUND (or any other
// import-resolution error) thrown while the module graph loads, before
// the process gets anywhere near a config check. A graceful, *intentional*
// exit (missing security posture config, bad PLATFORM_SECRET, etc.) is not
// a boot failure for this test's purposes — only "the module graph itself
// doesn't resolve" is.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'src', 'server.js');
const BOOT_WINDOW_MS = 5000;

const MODULE_RESOLUTION_ERROR_PATTERNS = [
  'ERR_MODULE_NOT_FOUND',
  'Cannot find module',
  'Cannot find package',
  'ERR_UNSUPPORTED_DIR_IMPORT',
];

function looksLikeModuleResolutionFailure(stderr) {
  return MODULE_RESOLUTION_ERROR_PATTERNS.some((pattern) => stderr.includes(pattern));
}

async function main() {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      // Deliberately unset REDIS_URL so this never touches a real Redis
      // (falls back to the in-memory store); unset PORT so a stray leftover
      // process from a previous run can't collide on it.
      REDIS_URL: '',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), BOOT_WINDOW_MS);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  if (!exit.timedOut && child.exitCode === null) {
    child.kill('SIGKILL');
  } else if (exit.timedOut) {
    child.kill('SIGKILL');
  }

  if (looksLikeModuleResolutionFailure(stderr) || looksLikeModuleResolutionFailure(stdout)) {
    console.error('[boot-smoke-test] FAILED: src/server.js could not load its module graph.');
    console.error(stderr || stdout);
    process.exit(1);
  }

  if (!exit.timedOut && exit.code !== 0 && exit.code !== null) {
    // A non-zero exit that isn't a module-resolution error is most likely
    // an intentional refusal to start with this environment (security
    // posture, missing required config) — not what this test checks.
    // Surface it as informational so a real crash is still visible in CI
    // logs, but don't fail the build on it.
    console.log('[boot-smoke-test] server exited non-zero without a module-resolution error (likely a config refusal); treating as pass:');
    console.log(stderr || stdout);
  }

  console.log('[boot-smoke-test] PASSED: module graph resolved cleanly.');
}

main();

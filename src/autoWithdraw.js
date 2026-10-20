import { StrKey } from '@stellar/stellar-sdk';
import { store } from './store.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { getOwedOnChain, buildWorkerWithdrawTx } from './stellarClient.js';
import { feeBumpWithdraw, feeBumpWithdrawTo } from './sponsor.js';
import { notifyWorker } from './push.js';
import { recordWorkerWithdrawal } from './earnings.js';
import { stroopsToUsdc } from './pricing.js';

/**
 * Configurable auto-withdraw: a worker sets a threshold, and once their
 * on-chain Owed balance reaches it, their full Owed balance is queued for
 * withdrawal without them having to check back and start it themselves.
 *
 * What "auto" can and can't mean here: withdraw()/withdraw_to() call
 * require_auth on the worker, and this backend never holds or signs with a
 * worker's key (see stellarClient.js's invokeAsAdmin, used only for
 * resolve()/refund()/charge()/touch()). So the backend can't move a
 * worker's money on its own, and that's deliberate. What it does:
 *
 *   1. Detect the crossing — right after a settlement credits the worker,
 *      and on a periodic sweep as a backstop.
 *   2. Prepare the exact unsigned withdraw transaction (simulated, with
 *      footprint and auth filled in) for the full Owed balance.
 *   3. Push it to the worker ("auto_withdraw_ready"). Their wallet, or an
 *      agent holding their key, signs it and POSTs it back, and it goes
 *      through the same fee-bump relay as /sponsor/withdraw, so the worker
 *      still needs zero XLM.
 *
 * One pending transaction per worker at a time. It's dropped when it
 * expires, when it's submitted, or when Owed falls below its amount (the
 * worker withdrew manually meanwhile), so a stale one can't sit there
 * failing at apply time.
 */

const SETTINGS_PREFIX = 'auto-withdraw:';
const PENDING_PREFIX = 'auto-withdraw-pending:';
const LOCK_PREFIX = 'auto-withdraw-lock:';
const INDEX_KEY = 'auto-withdraw-workers';
const LOCK_TTL_MS = 60_000;
const MAX_TRACKED_WORKERS = 5_000;
// The sweep used to check workers one at a time, so wall-clock time grew
// linearly with INDEX_KEY (each worker costs one or two RPC simulations).
// Run a bounded number of checks concurrently so a large index doesn't
// stretch the sweep past its interval, while still capping in-flight RPCs.
const SWEEP_CONCURRENCY = 8;

export class AutoWithdrawError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function isValidBeneficiary(address) {
  return StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address);
}

function parseThreshold(value) {
  let stroops;
  try {
    stroops = BigInt(value);
  } catch {
    throw new AutoWithdrawError('thresholdStroops must be an integer number of stroops');
  }
  if (stroops < config.autoWithdraw.minThresholdStroops) {
    throw new AutoWithdrawError(
      `thresholdStroops must be at least ${config.autoWithdraw.minThresholdStroops} (${stroopsToUsdc(config.autoWithdraw.minThresholdStroops)} USDC)`,
    );
  }
  return stroops;
}

function presentSettings(settings) {
  if (!settings) return { enabled: false, thresholdStroops: null, threshold: null, beneficiaryAddress: null };
  return {
    enabled: settings.enabled,
    thresholdStroops: settings.thresholdStroops,
    threshold: stroopsToUsdc(settings.thresholdStroops),
    beneficiaryAddress: settings.beneficiaryAddress,
    updatedAt: settings.updatedAt,
  };
}

function presentPending(pending) {
  if (!pending) return null;
  return {
    xdr: pending.xdr,
    amountStroops: pending.amountStroops,
    amount: stroopsToUsdc(pending.amountStroops),
    beneficiaryAddress: pending.beneficiaryAddress,
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
  };
}

async function indexWorker(workerAddress) {
  const known = (await store.get(INDEX_KEY)) || [];
  if (known.includes(workerAddress)) return;
  await store.set(INDEX_KEY, [workerAddress, ...known].slice(0, MAX_TRACKED_WORKERS));
}

async function unindexWorker(workerAddress) {
  const known = (await store.get(INDEX_KEY)) || [];
  if (!known.includes(workerAddress)) return;
  await store.set(
    INDEX_KEY,
    known.filter((a) => a !== workerAddress),
  );
}

export async function getAutoWithdrawSettings(workerAddress) {
  const settings = await store.get(SETTINGS_PREFIX + workerAddress);
  const pending = await store.get(PENDING_PREFIX + workerAddress);
  return { ...presentSettings(settings), pending: presentPending(pending) };
}

/** Creates or replaces a worker's settings. `enabled: false` keeps the
 * stored threshold (so re-enabling is one flag) but stops all checks and
 * drops any pending transaction. Changing the threshold or beneficiary
 * also drops a pending transaction, since it was prepared under the old
 * terms. */
export async function setAutoWithdrawSettings(workerAddress, { enabled = true, thresholdStroops, beneficiaryAddress = null } = {}) {
  if (!StrKey.isValidEd25519PublicKey(workerAddress)) {
    throw new AutoWithdrawError('auto-withdraw needs a real Stellar worker address');
  }
  if (typeof enabled !== 'boolean') throw new AutoWithdrawError('enabled must be a boolean');

  const current = await store.get(SETTINGS_PREFIX + workerAddress);
  const threshold =
    thresholdStroops !== undefined && thresholdStroops !== null
      ? parseThreshold(thresholdStroops)
      : current
        ? BigInt(current.thresholdStroops)
        : null;
  if (threshold === null) throw new AutoWithdrawError('thresholdStroops is required');

  if (beneficiaryAddress !== null && beneficiaryAddress !== undefined) {
    if (typeof beneficiaryAddress !== 'string' || !isValidBeneficiary(beneficiaryAddress)) {
      throw new AutoWithdrawError('beneficiaryAddress must be a valid Stellar account or contract address');
    }
    if (beneficiaryAddress === workerAddress) beneficiaryAddress = null;
  }

  const next = {
    enabled,
    thresholdStroops: threshold.toString(),
    beneficiaryAddress: beneficiaryAddress || null,
    updatedAt: Date.now(),
  };
  await store.set(SETTINGS_PREFIX + workerAddress, next);

  const termsChanged =
    !current ||
    !enabled ||
    current.thresholdStroops !== next.thresholdStroops ||
    (current.beneficiaryAddress || null) !== next.beneficiaryAddress;
  if (termsChanged) await store.delete(PENDING_PREFIX + workerAddress);

  if (enabled) await indexWorker(workerAddress);
  else await unindexWorker(workerAddress);

  return presentSettings(next);
}

export async function deleteAutoWithdrawSettings(workerAddress) {
  await store.delete(SETTINGS_PREFIX + workerAddress);
  await store.delete(PENDING_PREFIX + workerAddress);
  await unindexWorker(workerAddress);
}

/**
 * Checks one worker's Owed balance against their threshold and, if it's
 * reached, prepares and pushes the withdraw transaction. Safe to call as
 * often as you like: an existing pending transaction short-circuits it,
 * and a per-worker lock stops the settlement hook and the sweep from both
 * preparing one at the same moment.
 *
 * Returns { status, ... } where status is one of: 'disabled',
 * 'below_threshold', 'pending' (one already outstanding), 'prepared'
 * (just created), 'busy' (another check holds the lock).
 */
export async function checkAutoWithdraw(workerAddress) {
  const settings = await store.get(SETTINGS_PREFIX + workerAddress);
  if (!settings?.enabled) return { status: 'disabled' };

  const locked = await store.setNX(LOCK_PREFIX + workerAddress, Date.now(), LOCK_TTL_MS);
  if (!locked) return { status: 'busy' };

  try {
    const owed = await getOwedOnChain(workerAddress);
    const pending = await store.get(PENDING_PREFIX + workerAddress);

    if (pending) {
      // A manual withdraw since this was prepared means it would now fail
      // at apply time for insufficient Owed. Drop it and fall through to
      // re-evaluate against the current balance.
      if (owed >= BigInt(pending.amountStroops)) {
        return { status: 'pending', pending: presentPending(pending) };
      }
      await store.delete(PENDING_PREFIX + workerAddress);
    }

    const threshold = BigInt(settings.thresholdStroops);
    if (owed < threshold) {
      return { status: 'below_threshold', owedStroops: owed.toString(), thresholdStroops: threshold.toString() };
    }

    const { xdr, expiresAt } = await buildWorkerWithdrawTx(workerAddress, owed, settings.beneficiaryAddress);
    const record = {
      xdr,
      amountStroops: owed.toString(),
      beneficiaryAddress: settings.beneficiaryAddress || null,
      createdAt: Date.now(),
      expiresAt,
    };
    await store.set(PENDING_PREFIX + workerAddress, record);

    try {
      await notifyWorker(workerAddress, {
        type: 'auto_withdraw_ready',
        amountStroops: owed.toString(),
        amount: stroopsToUsdc(owed),
        beneficiaryAddress: settings.beneficiaryAddress || null,
        expiresAt,
      });
    } catch (err) {
      logger.warn({ err, workerAddress }, 'auto-withdraw: failed to push ready notification');
    }

    return { status: 'prepared', pending: presentPending(record) };
  } finally {
    await store.delete(LOCK_PREFIX + workerAddress);
  }
}

/**
 * Periodic backstop: checks every opted-in worker. Runs with bounded
 * concurrency (SWEEP_CONCURRENCY) so wall-clock time stays roughly flat as
 * INDEX_KEY grows toward MAX_TRACKED_WORKERS instead of scaling linearly
 * with the number of workers. Per-worker failures are logged and skipped so
 * one bad worker can't abort the sweep.
 */
export async function sweepAutoWithdraw() {
  const workers = (await store.get(INDEX_KEY)) || [];
  if (workers.length === 0) return { checked: 0, prepared: 0 };

  let prepared = 0;
  let next = 0;

  async function runWorker() {
    while (next < workers.length) {
      const workerAddress = workers[next++];
      try {
        const result = await checkAutoWithdraw(workerAddress);
        if (result.status === 'prepared') prepared += 1;
      } catch (err) {
        logger.warn({ err, workerAddress }, 'auto-withdraw: sweep check failed');
      }
    }
  }

  const lanes = Math.min(SWEEP_CONCURRENCY, workers.length);
  await Promise.all(Array.from({ length: lanes }, () => runWorker()));

  return { checked: workers.length, prepared };
}

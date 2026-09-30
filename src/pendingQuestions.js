import { randomBytes } from 'node:crypto';
import { store } from './store.js';
import { config } from './config.js';

const PREFIX = 'pending:';

/**
 * A random-per-process 32-bit salt, mixed into the high bits of every
 * question id this process mints. store.incr() on its own gives a
 * globally-unique, atomic sequence when Redis is configured — but the
 * in-memory fallback can only coordinate a sequence WITHIN its own process.
 * Two backend instances both running memory-only (e.g. an accidental
 * horizontal-scale deployment without REDIS_URL set) would otherwise mint
 * colliding ids, which doesn't just corrupt in-memory state — it makes a
 * real payer's on-chain submit() call fail with QuestionAlreadyExists.
 * Salting collapses that from "guaranteed collision" to "both processes
 * would need to independently generate the same random 32-bit salt AND the
 * same counter value," which is the same defense-in-depth whether or not
 * Redis is configured, so there's a single code path either way.
 */
const PROCESS_SALT = BigInt('0x' + randomBytes(4).toString('hex'));

const SEQ_KEY = 'question-id-seq';

export async function nextQuestionId() {
  const seq = await store.incr(SEQ_KEY);
  // salt (32 bits) in the high half, sequence (32 bits) in the low half —
  // always fits exactly within u64, the contract's question_id type.
  // Bounded to ~4.29 billion questions per process lifetime/shared counter
  // before the low half could bleed into the salt; nowhere near realistic
  // throughput for this system.
  return (PROCESS_SALT << 32n) | BigInt(seq);
}

/**
 * The set of configured contract instances a question may be opened against.
 * Each entry carries its own contract id and (optionally) its own admin key,
 * since two instances with independent platform keys must not share a serial
 * queue. Falls back to the single legacy `config.contractId` when no explicit
 * set is configured, so existing single-contract deployments keep working.
 */
export function getContractInstances() {
  if (Array.isArray(config.contracts) && config.contracts.length > 0) {
    return config.contracts;
  }
  return [{ id: config.contractId }];
}

/**
 * Pick which configured contract instance a new question opens against.
 * Random assignment across the configured set is sufficient for v1 (see
 * issue #138 out-of-scope: no capacity-aware selection yet). The chosen
 * instance is recorded in the stashed record so every later step resolves
 * the same instance.
 */
export function pickContractInstance() {
  const instances = getContractInstances();
  return instances[Math.floor(Math.random() * instances.length)];
}

/**
 * Resolve the contract instance a given question was opened against, using
 * the instance recorded in its stashed record. Returns undefined when the
 * record is missing or predates multi-contract support, letting callers fall
 * back to the legacy single-contract path.
 */
export async function getStashedContractInstance(questionId) {
  const stashed = await getStashedQuestion(questionId);
  if (!stashed || !stashed.contractId) return undefined;
  const instances = getContractInstances();
  return instances.find((instance) => instance.id === stashed.contractId);
}

export async function stashQuestion(questionId, data) {
  await store.set(PREFIX + questionId.toString(), data, config.pendingQuestionTtlMs);
}

export async function getStashedQuestion(questionId) {
  return store.get(PREFIX + questionId.toString());
}

export async function dropStashedQuestion(questionId) {
  await store.delete(PREFIX + questionId.toString());
}

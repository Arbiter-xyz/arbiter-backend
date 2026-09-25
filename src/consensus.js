/**
 * Configurable consensus rules. A payer picks one at question creation
 * (`consensusMode`, plus `tolerance` for numeric-tolerance); it's stashed
 * on the pending question next to tierKey/category and handed to
 * reconcile() at settlement time.
 *
 *  - 'exact' (default): today's behavior, byte for byte — normalized
 *    exact-string match with a Claude fallback (see reconcile.js).
 *  - 'numeric-tolerance': answers that parse as numbers match when they
 *    fall within `tolerance` of each other, so "42", "42.0", "about 42"
 *    and "$42" all agree without a Claude call. Answers that don't parse
 *    as numbers fall back to the exact-match string grouping.
 *
 * `tolerance` is either { percent: p } (0 <= p <= 100, relative to the
 * group's center value) or { absolute: d } (d >= 0, in the answer's own
 * units). Omitted, it defaults to { absolute: 0 }, i.e. numeric equality.
 */

export const CONSENSUS_MODES = Object.freeze(['exact', 'numeric-tolerance']);
export const DEFAULT_CONSENSUS_MODE = 'exact';

/**
 * Validates client input. Returns { ok: true, rule } where `rule` is null
 * for the default mode (so the default path stores and passes nothing new),
 * or { ok: false, error } with a message suitable for a 400.
 */
export function parseConsensusRule({ consensusMode, tolerance } = {}) {
  if (consensusMode === undefined || consensusMode === null || consensusMode === DEFAULT_CONSENSUS_MODE) {
    if (tolerance !== undefined && tolerance !== null) {
      return { ok: false, error: "tolerance is only valid with consensusMode 'numeric-tolerance'" };
    }
    return { ok: true, rule: null };
  }
  if (!CONSENSUS_MODES.includes(consensusMode)) {
    return { ok: false, error: `consensusMode must be one of: ${CONSENSUS_MODES.join(', ')}` };
  }

  if (tolerance === undefined || tolerance === null) {
    return { ok: true, rule: { mode: consensusMode, tolerance: { absolute: 0 } } };
  }
  if (typeof tolerance !== 'object' || Array.isArray(tolerance)) {
    return { ok: false, error: 'tolerance must be an object: { percent: number } or { absolute: number }' };
  }
  const keys = Object.keys(tolerance);
  if (keys.length !== 1 || !['percent', 'absolute'].includes(keys[0])) {
    return { ok: false, error: 'tolerance must have exactly one of: percent, absolute' };
  }
  const [kind] = keys;
  const value = tolerance[kind];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: `tolerance.${kind} must be a non-negative finite number` };
  }
  if (kind === 'percent' && value > 100) {
    return { ok: false, error: 'tolerance.percent must be at most 100' };
  }
  return { ok: true, rule: { mode: consensusMode, tolerance: { [kind]: value } } };
}

const APPROX_PREFIX = /^(?:about|approximately|approx\.?|around|roughly|circa|ca\.?|~|≈)\s*/;
const CURRENCY_SYMBOLS = /[$€£¥₹]/g;
const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/;
const THOUSANDS_GROUPED = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/**
 * Parses a worker's answer as a number, or returns null if it isn't one.
 * Handles an approximation prefix ("about", "~"), currency symbols, a
 * trailing percent sign ("42%" parses as 42, since every answer to one
 * question is presumably in the same unit), and comma thousands separators
 * in groups of three. A bare decimal comma ("3,5") is ambiguous and is NOT
 * parsed; it goes down the string path instead of risking a 1000x misread.
 */
export function parseNumericAnswer(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim().toLowerCase();
  s = s.replace(APPROX_PREFIX, '');
  s = s.replace(CURRENCY_SYMBOLS, '');
  s = s.replace(/\s+/g, '');
  s = s.replace(/\.$/, ''); // trailing sentence period: "42."
  if (s.endsWith('%')) s = s.slice(0, -1);
  if (THOUSANDS_GROUPED.test(s)) s = s.replace(/,/g, '');
  if (!PLAIN_NUMBER.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function withinTolerance(value, center, tolerance) {
  const delta = Math.abs(value - center);
  if ('percent' in tolerance) return delta <= (Math.abs(center) * tolerance.percent) / 100;
  return delta <= tolerance.absolute;
}

/**
 * Picks the largest cluster of numeric values that all fall within
 * tolerance of one member (the "center"). Tolerance isn't transitive (with
 * ±1, 1 and 3 both match 2 but not each other), so every value is tried as
 * the center and the one that gathers the most members wins. Ties go to
 * the tighter cluster (smaller total deviation), then to the earlier
 * submission, so the result is deterministic.
 *
 * `entries` is [{ workerId, answer, value }]. Returns { center, members }
 * or null for an empty input.
 */
export function largestToleranceCluster(entries, tolerance) {
  let best = null;
  for (const candidate of entries) {
    const members = entries.filter((e) => withinTolerance(e.value, candidate.value, tolerance));
    const spread = members.reduce((sum, e) => sum + Math.abs(e.value - candidate.value), 0);
    if (!best || members.length > best.members.length || (members.length === best.members.length && spread < best.spread)) {
      best = { center: candidate, members, spread };
    }
  }
  return best && { center: best.center, members: best.members };
}

/**
 * The numeric-tolerance counterpart of reconcile.js's exactMatchVote(),
 * with the same return shape ({ consensus, confidence, matchingWorkerIds,
 * allAgree }) so reconcile() can use either one. Answers that parse as
 * numbers are clustered by tolerance; the rest are grouped with
 * `stringGrouper` (exactMatchVote's normalized-text grouping). The biggest
 * group wins, and a tie goes to the numeric cluster since the payer asked
 * for numeric matching. Confidence is always measured against ALL
 * submissions, numeric or not.
 */
export function numericToleranceVote(submissions, tolerance, stringGrouper) {
  const numeric = [];
  const nonNumeric = [];
  for (const s of submissions) {
    const value = parseNumericAnswer(s.answer);
    if (value === null) nonNumeric.push(s);
    else numeric.push({ ...s, value });
  }

  let winner = null;
  const cluster = largestToleranceCluster(numeric, tolerance);
  if (cluster) {
    winner = { representative: cluster.center.answer, workerIds: cluster.members.map((e) => e.workerId) };
  }
  for (const group of stringGrouper(nonNumeric)) {
    if (!winner || group.workerIds.length > winner.workerIds.length) winner = group;
  }

  return {
    consensus: winner.representative,
    confidence: winner.workerIds.length / submissions.length,
    matchingWorkerIds: winner.workerIds,
    allAgree: winner.workerIds.length === submissions.length,
  };
}

export function describeTolerance(tolerance) {
  if ('percent' in tolerance) return `within ${tolerance.percent}% of each other`;
  return `within ${tolerance.absolute} (absolute) of each other`;
}

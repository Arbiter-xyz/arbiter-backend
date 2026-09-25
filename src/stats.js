/**
 * Aggregate counters for the public /stats surface. Kept as a tiny pure
 * module so the counters are trivially testable and have no hidden state of
 * their own — callers own persistence.
 *
 * Issue #13 adds shadow-mode AI baseline counters alongside the existing
 * resolved/refunded tallies: for questions dispatched on a real quorum tier
 * we also generate the instant-tier LLM draft in shadow and record whether it
 * matched the human-reconciled consensus. These counters are keyed the same
 * way as resolved/refunded so they aggregate with the same machinery, and are
 * purely observability — they never touch settlement, timing, or cost.
 */

export function emptyStats() {
  return {
    resolved: 0,
    refunded: 0,
    // Shadow-mode AI baseline (issue #13).
    shadowMatched: 0,
    shadowMismatched: 0,
    shadowRefunded: 0,
  };
}

/**
 * Folds a single shadow-agreement record (see pricing.js's
 * recordShadowAgreement) into the running counters. A record that wasn't
 * counted (refunded / no consensus) only bumps shadowRefunded, so the
 * agreement rate stays a clean matched/(matched+mismatched) ratio.
 */
export function applyShadowAgreement(stats, record) {
  if (!record || !record.counted) {
    return { ...stats, shadowRefunded: stats.shadowRefunded + 1 };
  }
  return record.matched
    ? { ...stats, shadowMatched: stats.shadowMatched + 1 }
    : { ...stats, shadowMismatched: stats.shadowMismatched + 1 };
}

/**
 * Public view of the counters, including the aggregate shadow agreement rate.
 * `shadowAgreementRate` is null until at least one comparison has been
 * counted, so we never publish a misleading 0% before any data exists.
 */
export function publicStats(stats) {
  const counted = stats.shadowMatched + stats.shadowMismatched;
  return {
    resolved: stats.resolved,
    refunded: stats.refunded,
    shadow: {
      matched: stats.shadowMatched,
      mismatched: stats.shadowMismatched,
      refunded: stats.shadowRefunded,
      counted,
      agreementRate: counted > 0 ? stats.shadowMatched / counted : null,
    },
  };
}

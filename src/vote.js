/**
 * The deterministic exact-match vote, kept in its own dependency-free
 * module (no config, no SDK client) so that provenanceVerify.js and
 * scripts/verify-provenance.js can re-run exactly the same vote the backend
 * ran, without booting any of the backend's runtime.
 */

export function normalize(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function exactMatchVote(submissions) {
  const groups = new Map(); // normalized -> { representative, workerIds }
  for (const { workerId, answer } of submissions) {
    const norm = normalize(answer);
    if (!groups.has(norm)) groups.set(norm, { representative: answer, workerIds: [] });
    groups.get(norm).workerIds.push(workerId);
  }

  let winner = null;
  for (const group of groups.values()) {
    if (!winner || group.workerIds.length > winner.workerIds.length) winner = group;
  }

  return {
    consensus: winner.representative,
    confidence: winner.workerIds.length / submissions.length,
    matchingWorkerIds: winner.workerIds,
    allAgree: winner.workerIds.length === submissions.length,
  };
}

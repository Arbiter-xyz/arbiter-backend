import { config } from './config.js';

// Profanity/spam screen applied to worker answers BEFORE they are recorded
// in a question's quorum collector (see dispatch.js's submitAnswer), so a
// rejected answer never counts toward consensus. Off by default: what counts
// as "profane" is operator- and audience-specific, so the blocklist is
// supplied through config rather than hardcoded here.
//
// Every check is deliberately cheap and deterministic (no network, no LLM):
// it runs synchronously on the answer hot path for every submission.

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Blocklist terms match on word boundaries, case-insensitively, so "ass"
// doesn't flag "class". Compiled once per distinct blocklist.
let compiledFor = null;
let compiledPattern = null;
function blocklistPattern(terms) {
  if (compiledFor !== terms) {
    compiledFor = terms;
    const cleaned = terms.map((t) => t.trim().toLowerCase()).filter(Boolean);
    compiledPattern = cleaned.length
      ? new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${cleaned.map(escapeRegExp).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu')
      : null;
  }
  return compiledPattern;
}

/**
 * Screen one answer. Returns { ok: true } when it may count toward
 * consensus, or { ok: false, reason } naming the first rule it tripped.
 * `opts` defaults to config.answerFilter and exists so callers can screen
 * against a different policy without mutating the frozen config.
 */
export function screenAnswer(answer, opts = config.answerFilter) {
  if (!opts || !opts.enabled) return { ok: true };
  if (typeof answer !== 'string') return { ok: false, reason: 'answer must be a string' };

  const text = answer.normalize('NFKC');

  const pattern = blocklistPattern(opts.blocklist);
  if (pattern && pattern.test(text)) {
    return { ok: false, reason: 'answer contains blocked language' };
  }

  if (opts.maxLinks >= 0) {
    const links = text.match(URL_PATTERN);
    if (links && links.length > opts.maxLinks) {
      return { ok: false, reason: `answer contains more than ${opts.maxLinks} link(s)` };
    }
  }

  if (opts.maxRepeatedChars > 0) {
    // A run of the same character longer than the limit ("!!!!!!!!!!",
    // "aaaaaaaaaaaa") is a classic filler/spam signal.
    const run = new RegExp(`(.)\\1{${opts.maxRepeatedChars},}`, 'su');
    if (run.test(text)) {
      return { ok: false, reason: `answer repeats a character more than ${opts.maxRepeatedChars} times in a row` };
    }
  }

  if (opts.maxUppercaseRatio > 0 && opts.maxUppercaseRatio < 1) {
    const letters = text.match(/\p{L}/gu) || [];
    if (letters.length >= opts.minLettersForCaseCheck) {
      const upper = letters.filter((c) => c !== c.toLowerCase() && c === c.toUpperCase()).length;
      if (upper / letters.length > opts.maxUppercaseRatio) {
        return { ok: false, reason: 'answer is mostly uppercase' };
      }
    }
  }

  return { ok: true };
}

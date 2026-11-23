import { config } from './config.js';

/**
 * Validates a caller-supplied question body (issue #562). Shared by every
 * route that creates a question (POST /oracle/sandbox and each payment branch
 * of POST /oracle) so the rule and its error messages live in one place.
 *
 * Returns an error string suitable for a 400 response, or null when the
 * question is a non-empty string no longer than `maxLength`.
 */
export function validateQuestion(question, maxLength = config.maxQuestionLength) {
  if (!question || typeof question !== 'string') {
    return 'body.question (string) is required';
  }
  if (question.length > maxLength) {
    return `body.question must be at most ${maxLength} characters`;
  }
  return null;
}

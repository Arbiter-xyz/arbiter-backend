'use strict';

const { normalizeCategory } = require('./dispatch');

const CERTIFICATION_PREFIX = 'certification:';

// Seeded quiz content per category. Admin authoring UI is out of scope (#82);
// this is the hardcoded baseline that certification is checked against.
const QUIZZES = {
  'smart-contract-audit': [
    {
      id: 'sca-1',
      prompt: 'Which Solidity construct most commonly enables reentrancy?',
      options: [
        'External call before state update',
        'Use of view functions',
        'Immutable variables',
        'Event emission'
      ],
      answer: 0
    },
    {
      id: 'sca-2',
      prompt: 'What does a `delegatecall` preserve that a `call` does not?',
      options: [
        'The caller\'s msg.sender only',
        'The calling contract\'s storage context',
        'The gas limit',
        'The block timestamp'
      ],
      answer: 1
    }
  ],
  'code-review': [
    {
      id: 'cr-1',
      prompt: 'What is the primary purpose of a code review?',
      options: [
        'To catch defects and share knowledge',
        'To enforce a specific formatting style',
        'To slow down merges',
        'To replace automated tests'
      ],
      answer: 0
    }
  ]
};

function certificationKey(workerId, category) {
  return `${CERTIFICATION_PREFIX}${workerId}:${normalizeCategory(category)}`;
}

function getQuiz(category) {
  const normalized = normalizeCategory(category);
  const quiz = QUIZZES[normalized];
  if (!quiz) return null;
  // Never leak the answer key to the client.
  return quiz.map(({ id, prompt, options }) => ({ id, prompt, options }));
}

function hasQuiz(category) {
  return Boolean(QUIZZES[normalizeCategory(category)]);
}

function isCertified(store, workerId, category) {
  if (!store || typeof store.get !== 'function') return false;
  return Boolean(store.get(certificationKey(workerId, category)));
}

function gradeQuiz(category, answers) {
  const normalized = normalizeCategory(category);
  const quiz = QUIZZES[normalized];
  if (!quiz) return { passed: false, reason: 'unknown-category' };
  if (!Array.isArray(answers)) return { passed: false, reason: 'invalid-answers' };

  const byId = new Map();
  for (const entry of answers) {
    if (entry && typeof entry.id === 'string') byId.set(entry.id, entry.answer);
  }

  for (const question of quiz) {
    if (byId.get(question.id) !== question.answer) {
      return { passed: false, reason: 'incorrect-answer' };
    }
  }
  return { passed: true };
}

function certify(store, workerId, category, answers) {
  const result = gradeQuiz(category, answers);
  if (!result.passed) return result;
  if (store && typeof store.set === 'function') {
    store.set(certificationKey(workerId, category), {
      workerId,
      category: normalizeCategory(category),
      certifiedAt: Date.now()
    });
  }
  return result;
}

module.exports = {
  CERTIFICATION_PREFIX,
  QUIZZES,
  certificationKey,
  getQuiz,
  hasQuiz,
  isCertified,
  gradeQuiz,
  certify
};

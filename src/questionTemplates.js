'use strict';

const config = require('./config');

const TEMPLATE_PREFIX = 'questionTemplate:';
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function templateKey(templateId) {
  return `${TEMPLATE_PREFIX}${templateId}`;
}

function normalizeTemplateId(templateId) {
  if (typeof templateId !== 'string') return null;
  const trimmed = templateId.trim();
  if (!trimmed) return null;
  return trimmed;
}

function extractPlaceholders(pattern) {
  const names = new Set();
  let match;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(pattern)) !== null) {
    names.add(match[1]);
  }
  return Array.from(names);
}

function validateTemplateInput(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'template body must be an object' };
  }
  const { pattern, tierKey, category } = input;
  if (typeof pattern !== 'string' || !pattern.trim()) {
    return { ok: false, error: 'pattern is required and must be a non-empty string' };
  }
  if (typeof tierKey !== 'string' || !tierKey.trim()) {
    return { ok: false, error: 'tierKey is required and must be a non-empty string' };
  }
  if (typeof category !== 'string' || !category.trim()) {
    return { ok: false, error: 'category is required and must be a non-empty string' };
  }
  return {
    ok: true,
    value: {
      pattern: pattern.trim(),
      tierKey: tierKey.trim(),
      category: category.trim(),
    },
  };
}

async function registerTemplate(store, templateId, input) {
  const id = normalizeTemplateId(templateId);
  if (!id) {
    return { ok: false, status: 400, error: 'templateId is required' };
  }
  const validated = validateTemplateInput(input);
  if (!validated.ok) {
    return { ok: false, status: 400, error: validated.error };
  }
  const { pattern, tierKey, category } = validated.value;
  const placeholders = extractPlaceholders(pattern);
  const record = {
    templateId: id,
    pattern,
    tierKey,
    category,
    placeholders,
    createdAt: new Date().toISOString(),
  };
  await store.set(templateKey(id), record);
  return { ok: true, template: record };
}

async function getTemplate(store, templateId) {
  const id = normalizeTemplateId(templateId);
  if (!id) return null;
  const record = await store.get(templateKey(id));
  return record || null;
}

function interpolateTemplate(template, variables) {
  const vars = variables && typeof variables === 'object' ? variables : {};
  const missing = [];
  const question = template.pattern.replace(PLACEHOLDER_RE, (_full, name) => {
    const value = vars[name];
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return '';
    }
    return String(value);
  });
  if (missing.length > 0) {
    return { ok: false, status: 400, error: `missing template variables: ${missing.join(', ')}` };
  }
  const trimmed = question.trim();
  if (!trimmed) {
    return { ok: false, status: 400, error: 'interpolated question is empty' };
  }
  if (trimmed.length > config.maxQuestionLength) {
    return {
      ok: false,
      status: 400,
      error: `interpolated question exceeds maxQuestionLength (${config.maxQuestionLength})`,
    };
  }
  return { ok: true, question: trimmed };
}

module.exports = {
  registerTemplate,
  getTemplate,
  interpolateTemplate,
  extractPlaceholders,
};

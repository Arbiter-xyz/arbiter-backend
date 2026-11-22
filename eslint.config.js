import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

/**
 * ESLint config (#220). Two large cleanup PRs (#218, #219) fixed ~90 bugs
 * — duplicate top-level declarations, missing imports, orphaned fragments
 * from bad merges — that a basic linter catches instantly. This is wired
 * into CI (.github/workflows/ci.yml) as a required check.
 */
export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'scripts/**/*.js'],
    ignores: ['node_modules/**', 'arbiter-app/**', 'mcp-server/**', 'sdk/**'],
    plugins: { import: importPlugin },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
      'import/no-unresolved': 'error',
      'import/named': 'error',
    },
    settings: {
      'import/resolver': { node: { extensions: ['.js'] } },
    },
  },
];

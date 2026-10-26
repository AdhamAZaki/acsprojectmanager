// Code checks (npm run lint). Only ESLint's built-in rules, so nothing else to install.
// They catch the mistakes that matter in plain browser JS: typos in names, leftovers,
// unreachable code, duplicate keys.
const browser = ['window', 'document', 'navigator', 'location', 'localStorage', 'console', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'confirm', 'fetch', 'URL', 'Blob', 'ClipboardItem', 'CustomEvent', 'Request', 'Response',
  'Promise', 'Map', 'Set', 'JSON', 'Math', 'Date', 'Number', 'String', 'Array', 'Object', 'Error', 'encodeURIComponent'];
const worker = ['self', 'caches', 'location', 'fetch', 'URL', 'Request', 'Response', 'Promise'];
const node = ['require', 'module', 'process', '__dirname', 'console', 'setTimeout', 'clearTimeout', 'URL', 'Promise'];
const asGlobals = (list, extra) => Object.fromEntries(list.concat(extra || []).map(n => [n, 'readonly']));

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-const-assign': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-func-assign': 'error',
  'no-sparse-arrays': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  eqeqeq: ['error', 'always'],
};

module.exports = [
  { files: ['frontend/js/**/*.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: asGlobals(browser) }, rules },
  { files: ['frontend/sw.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: asGlobals(worker) }, rules },
  // fake-supabase.js runs in the browser; the rest of the tests and scripts run in Node.
  { files: ['tests/e2e/fake-supabase.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: asGlobals(browser) }, rules },
  { files: ['tests/**/*.js', 'scripts/**/*.js', 'eslint.config.js'], ignores: ['tests/e2e/fake-supabase.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: asGlobals(node, browser) }, rules },
];

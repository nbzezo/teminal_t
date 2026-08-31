'use strict';

/**
 * Cấu hình ESLint phẳng, không phụ thuộc gói preset nào ngoài chính ESLint.
 *
 * Main process là CommonJS chạy trong Node; renderer là ES module chạy trong
 * Chromium và nạp xterm qua ba thẻ <script> toàn cục. Hai môi trường khác nhau
 * nên phải khai báo riêng, nếu không no-undef sẽ báo nhầm cả hai phía.
 */

const timers = {
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly',
};

const nodeGlobals = {
  ...timers,
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  setImmediate: 'readonly',
  structuredClone: 'readonly',
  URL: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
};

const browserGlobals = {
  ...timers,
  window: 'readonly',
  document: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  navigator: 'readonly',
  getComputedStyle: 'readonly',
  requestAnimationFrame: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  KeyboardEvent: 'readonly',
  InputEvent: 'readonly',
  MouseEvent: 'readonly',
  // xterm và hai addon được nạp bằng thẻ <script> nên là biến toàn cục
  Terminal: 'readonly',
  FitAddon: 'readonly',
  SearchAddon: 'readonly',
};

const rules = {
  'no-undef': 'error',
  // ignoreRestSiblings: `const { password, ...rest } = conn` là cách bỏ bớt một
  // trường, không phải biến bị quên.
  'no-unused-vars': [
    'error',
    { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'all', ignoreRestSiblings: true },
  ],
  'no-var': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'smart'],
  'no-implicit-coercion': ['error', { boolean: false, allow: ['!!'] }],
  'no-return-await': 'error',
  'no-throw-literal': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-duplicate-imports': 'error',
  'no-self-compare': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-constant-binary-expression': 'error',
  'require-atomic-updates': 'off',
  // Bắt lại đúng lỗi từng làm sập ứng dụng: nuốt lỗi mà không xử lý gì.
  'no-empty': ['error', { allowEmptyCatch: false }],
};

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', '.builder-cache/**'],
  },
  {
    files: ['src/main/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules,
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: browserGlobals,
    },
    rules,
  },
];

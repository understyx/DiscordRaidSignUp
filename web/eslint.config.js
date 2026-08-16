'use strict';

const js = require('@eslint/js');

module.exports = [
  {
    ignores: ['node_modules/', 'static/'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        __dirname: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        module: 'readonly',
        process: 'readonly',
        require: 'readonly',
        setTimeout: 'readonly',
      },
      sourceType: 'commonjs',
    },
    rules: {
      'no-empty': 'off',
      'no-unused-vars': 'off',
    },
  },
];

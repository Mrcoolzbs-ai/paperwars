/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'prettier',
  ],
  env: { node: true, es2022: true },
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    'import/no-duplicates': 'error',
    // TypeScript NodeNext resolves relative .js specifiers to .ts source files.
    // tsc validates module paths; eslint-plugin-import's Node resolver does not.
'import/no-unresolved': ['error', { ignore: ['\.js
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
  ignorePatterns: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'pnpm-lock.yaml'],
};
, '^vitest/config
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
  ignorePatterns: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'pnpm-lock.yaml'],
};
] }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
  ignorePatterns: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'pnpm-lock.yaml'],
};

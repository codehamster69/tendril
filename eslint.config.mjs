import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', '**/dist*/**', '**/dist-api/**', '**/.vercel/**', '**/out/**', '**/release/**', '**/test-results/**', '**/playwright-report/**', '**/public/models/**', '**/.data/**', '**/.tmp/**', '**/.astro/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
  {
    files: ['**/*.{ts,mjs,cjs,js}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.worker } },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] },
  },
];

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.superpowers/**', '**/validation.generated.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
];

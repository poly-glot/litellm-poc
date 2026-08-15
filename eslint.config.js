import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'litellm/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['services/main-app-frontend/src/public/**/*.js'],
    languageOptions: {
      globals: {
        TextEncoder: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        crypto: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        history: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
      },
    },
  },
  prettier,
);

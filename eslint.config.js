import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'drizzle', 'sessions', 'data'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/admin/public/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        FullCalendar: 'readonly',
        location: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        URLSearchParams: 'readonly',
        localStorage: 'readonly',
        confirm: 'readonly',
        alert: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        FormData: 'readonly',
        Intl: 'readonly',
        navigator: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);

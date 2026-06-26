import js from '@eslint/js';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**'],
  },
  js.configs.recommended,
  // Type-aware TypeScript rules scoped to .ts files only;
  // .svelte files are excluded because the project service cannot parse them
  // without the Svelte preprocessor — Svelte-specific issues are caught by svelte-check.
  {
    files: ['**/*.ts'],
    extends: tseslint.configs.recommendedTypeChecked,
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.js', 'svelte.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  },
  ...svelte.configs['flat/recommended'],
  {
    // Svelte components: parse TypeScript inside <script lang="ts">
    // and enable browser globals present in every Svelte component context.
    files: ['**/*.svelte'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      // These Sets are function-local accumulators, not reactive state — SvelteSet is not needed.
      'svelte/prefer-svelte-reactivity': 'off',
    },
  },
  {
    files: ['*.config.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    // Test-specific overrides: stubs implementing async interfaces without awaiting,
    // and unsafe-any patterns that are inherent to test fixture wiring.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    // fakeHermes.ts is a test helper implementing an async interface synchronously
    files: ['src/hermes/fakeHermes.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
);

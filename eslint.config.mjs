import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'src/viewer/public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // This config file is not in tsconfig's include list and does not
          // need to be -- but the type-aware rules refuse to look at a file
          // they cannot place in a project, so it is allowed explicitly rather
          // than being silently unlinted.
          allowDefaultProject: ['eslint.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The three that carry weight in this codebase. `any` and non-null
      // assertions are how a type error gets silenced instead of fixed, and
      // both are explicitly forbidden by CLAUDE.md -- a lint rule is how that
      // stops being a matter of discipline.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // A floating promise in a request handler is a silently dropped error and
      // in a worker loop it is a lost job.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',

      // NestJS constructor parameter properties and decorator metadata trip
      // several of the stricter defaults without indicating a real problem.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-unsafe-declaration-merging': 'off',

      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // Hashing JSON without canonicalising it is the single most damaging
          // mistake available in this codebase, and it fails months later on an
          // unrelated change rather than at the point of the error. See ADR-0009
          // and src/common/canonical-json.ts.
          //
          // Scoped to the actual mistake -- a digest taken over stringify output
          // -- rather than to JSON.stringify generally. The canonicaliser itself
          // relies on JSON.stringify for string escaping, and a rule that
          // flagged every call would be turned off within a week.
          selector:
            "CallExpression[callee.name=/^(sha256Hex|createHash)$/] CallExpression[callee.object.name='JSON'][callee.property.name='stringify']",
          message:
            'Do not digest JSON.stringify output; key order is not deterministic. Use digestCanonical() from src/common/digest.ts.',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.ts', 'test/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);

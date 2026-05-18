import { defineConfig } from 'vitest/config';

/**
 * Two projects, because the two kinds of test here have genuinely different
 * costs and should be runnable independently.
 *
 * `unit` covers the pure, load-bearing logic -- the run state machine, RFC 8785
 * canonicalisation, digest helpers, cursor encoding. Milliseconds, no Docker,
 * runs on every save.
 *
 * `integration` runs against a real PostgreSQL and a real MinIO via
 * Testcontainers, because the guarantees this service makes live in row-level
 * security policies, triggers, grants and presigned multipart uploads. None of
 * those exist in a mock, so a mocked version of these tests would assert
 * nothing (ADR-012). It is slower and it needs Docker, and that is the price.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.ts'],
          environment: 'node',
          globalSetup: ['test/integration/global-setup.ts'],
          // Containers start once and are shared. Suites isolate by creating
          // their own tenants rather than by tearing the database down, which
          // is both faster and a better model of production, where the database
          // is never empty.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.module.ts', 'src/main.ts', 'src/worker.ts', 'src/viewer/**'],
    },
  },
});

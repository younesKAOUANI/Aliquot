/**
 * Fail with an explanation rather than a connection error.
 *
 * The browser suite deliberately does not start its own stack, so the common
 * failure is running it against nothing. Without this, that surfaces as
 * `net::ERR_CONNECTION_REFUSED` on every test, which says where the request
 * went and not what to do about it.
 */

const BASE_URL = process.env.ALIQUOT_E2E_BASE_URL ?? 'http://localhost:3000';

export default async function globalSetup(): Promise<void> {
  const readyz = `${BASE_URL}/readyz`;

  let response: Response;
  try {
    response = await fetch(readyz, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(
      `The viewer suite needs a running stack and ${readyz} is unreachable ` +
        `(${error instanceof Error ? error.message : String(error)}).\n\n` +
        '  docker compose up --wait api worker\n' +
        '  docker compose up seed\n\n' +
        'If the stack is on non-default ports, point the suite at it:\n' +
        '  ALIQUOT_E2E_BASE_URL=http://localhost:3100 npm run test:e2e',
    );
  }

  if (!response.ok) {
    throw new Error(
      `${readyz} answered ${response.status}. The API is up but not ready -- ` +
        'readiness includes object storage, so MinIO is the usual cause.',
    );
  }

  // The viewer renders seeded data. An empty database produces a suite that
  // passes every assertion it reaches and reaches almost none of them.
  const probe = await fetch(`${BASE_URL}/v1/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'mara.okafor@acme.test', tenantSlug: 'acme' }),
  });

  if (!probe.ok) {
    throw new Error(
      `The seeded demo user could not sign in (${probe.status}). Run the seed:\n` +
        '  docker compose up seed',
    );
  }
}

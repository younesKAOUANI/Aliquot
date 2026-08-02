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
  // The browser honours `ignoreHTTPSErrors` from the Playwright config; the
  // probes below use Node's fetch, which does not. Same opt-in flag so the two
  // cannot disagree about whether this run trusts an internal CA.
  if (process.env.ALIQUOT_E2E_INSECURE_TLS === 'true') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

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
  //
  // There are two ways in and a given stack has exactly one of them, because
  // AUTH_DEV_TOKEN_ENDPOINT and DEMO_MODE are mutually exclusive by a startup
  // check. A development stack has the first; the public deployment has the
  // second. Probing both and recording which answered lets the same suite run
  // against either, rather than only ever being exercised against the one
  // configuration that is not the one users see.
  const devSignIn = await fetch(`${BASE_URL}/v1/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'mara.okafor@acme.test', tenantSlug: 'acme' }),
  }).catch(() => undefined);

  const demoSignIn = await fetch(`${BASE_URL}/v1/auth/demo`, { method: 'POST' }).catch(
    () => undefined,
  );

  process.env.ALIQUOT_E2E_DEV_SIGNIN = devSignIn?.ok ? 'true' : 'false';
  process.env.ALIQUOT_E2E_DEMO_SIGNIN = demoSignIn?.ok ? 'true' : 'false';

  if (!devSignIn?.ok && !demoSignIn?.ok) {
    throw new Error(
      'Neither sign-in mechanism is available.\n' +
        `  POST /v1/auth/token -> ${devSignIn?.status ?? 'unreachable'}\n` +
        `  POST /v1/auth/demo  -> ${demoSignIn?.status ?? 'unreachable'}\n\n` +
        'A 503 from /v1/auth/demo means the stack is up and unseeded:\n' +
        '  docker compose up seed',
    );
  }
}

import { type Page, expect, test } from '@playwright/test';

/**
 * The viewer, driven as a reviewer would drive it.
 *
 * This suite exists because two bugs shipped that every other layer was blind
 * to. The API required `tenantSlug` on the dev token endpoint and the viewer
 * never sent it, so signing in failed with a validation error; and the token
 * response nests the principal under `user`, so `result.displayName` was always
 * `undefined` and the greeting silently fell back to the email. Both are
 * wiring, not logic: the integration suite calls the API directly and the unit
 * tests never load a page, so neither could have caught either one.
 *
 * The scope is therefore narrow on purpose. It asserts that the viewer talks to
 * the API correctly and renders what comes back. It does not re-assert the
 * guarantees -- those live in the database and are covered against a real
 * PostgreSQL in `test/integration`.
 */

const ACME = { tenantSlug: 'acme', email: 'mara.okafor@acme.test' };
const NORTHWIND = { tenantSlug: 'northwind', email: 'ines.duarte@northwind.test' };

/**
 * Which sign-in the stack under test offers, decided in globalSetup.
 *
 * AUTH_DEV_TOKEN_ENDPOINT and DEMO_MODE are mutually exclusive, so a stack has
 * one or the other: development has the form, the public deployment has the
 * demo button. Tests that are *about* the form skip when it is absent; tests
 * about everything else take whichever door is open, so the suite means
 * something when pointed at production.
 */
const DEV_SIGNIN = process.env.ALIQUOT_E2E_DEV_SIGNIN !== 'false';
const DEMO_SIGNIN = process.env.ALIQUOT_E2E_DEMO_SIGNIN === 'true';

async function signIn(page: Page, who: { tenantSlug: string; email: string }): Promise<void> {
  await page.goto('/');

  if (DEV_SIGNIN) {
    await page.fill('#tenant', who.tenantSlug);
    await page.fill('#email', who.email);
    await page.click('#signin');
  } else {
    await page.click('#demo-signin');
  }

  await expect(page.locator('#runs-table tbody tr')).not.toHaveCount(0);
}

test.describe('signing in', () => {
  test.skip(!DEV_SIGNIN, 'the tenant+email form needs AUTH_DEV_TOKEN_ENDPOINT');

  test('regression: the tenant slug is sent, so sign-in succeeds', async ({ page }) => {
    // The reported bug. The viewer posted only { email } and the endpoint
    // answered 400 "body tenantSlug: Invalid input: expected string, received
    // undefined", which surfaced in the footer and nowhere else.
    await page.goto('/');
    await page.fill('#tenant', ACME.tenantSlug);
    await page.fill('#email', ACME.email);
    await page.click('#signin');

    await expect(page.locator('#error')).toHaveText('');
    await expect(page.locator('#token')).not.toHaveValue('');
  });

  test('regression: the greeting shows the display name, not the email', async ({ page }) => {
    // The token response nests the principal under `user`. Reading
    // result.displayName yielded undefined and fell through to the email, which
    // looked plausible enough to survive review.
    await signIn(page, ACME);

    const whoami = await page.locator('#whoami').textContent();
    expect(whoami?.trim()).not.toBe('');
    expect(whoami?.trim()).not.toBe(ACME.email);
  });

  test('an unknown tenant is refused with a readable problem detail', async ({ page }) => {
    await page.goto('/');
    await page.fill('#tenant', 'no-such-tenant');
    await page.fill('#email', ACME.email);
    await page.click('#signin');

    await expect(page.locator('#error')).not.toHaveText('');
    await expect(page.locator('#token')).toHaveValue('');
  });

  test('a missing tenant is caught before the request is sent', async ({ page }) => {
    await page.goto('/');
    await page.fill('#tenant', '');
    await page.fill('#email', ACME.email);
    await page.click('#signin');

    await expect(page.locator('#error')).toContainText('tenant');
  });
});

test.describe('runs', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ACME);
  });

  test('lists the seeded runs across the lifecycle', async ({ page }) => {
    const states = await page.locator('#runs-table tbody .badge').allTextContents();

    expect(states.length).toBeGreaterThan(1);
    // The seed deliberately covers more than the happy path, and the viewer
    // should render the awkward states as readily as the clean ones.
    expect(states).toContain('PROCESSED');
    expect(states.some((state) => ['QUARANTINED', 'ABANDONED', 'OPEN'].includes(state))).toBe(true);
  });

  test('filters by state', async ({ page }) => {
    await page.selectOption('#filter-state', 'PROCESSED');
    await expect(page.locator('#runs-table tbody tr')).not.toHaveCount(0);

    const states = await page.locator('#runs-table tbody .badge').allTextContents();
    expect(new Set(states)).toEqual(new Set(['PROCESSED']));
  });

  test('opening a run shows its manifest and digest', async ({ page }) => {
    await page.locator('#runs-table tbody tr').first().click();

    await expect(page.locator('#run-detail')).toContainText('Manifest');
    await expect(page.locator('#run-detail .kv')).toContainText('manifest digest');
    // A 64-character hex digest, rendered rather than truncated to nothing.
    await expect(page.locator('#run-detail .kv dd').nth(2)).toHaveText(/^[0-9a-f]{64}$/);
  });
});

test.describe('lineage', () => {
  test('walks from a run artifact to the graph that produced it', async ({ page }) => {
    await signIn(page, ACME);

    // The path a reviewer actually takes: pick a processed run, then click a
    // verified manifest entry to jump straight to its provenance.
    await page
      .locator('#runs-table tbody tr', { has: page.locator('.badge.PROCESSED') })
      .first()
      .click();
    await expect(page.locator('#run-detail')).toContainText('Manifest');

    const boundEntry = page
      .locator('#run-detail tbody tr')
      .filter({ hasNot: page.locator('[data-artifact=""]') })
      .first();
    await boundEntry.click();

    await expect(page.locator('#view-lineage')).toHaveClass(/active/);
    await expect(page.locator('#lineage-graph svg')).toBeVisible();

    // A graph with edges, not a single orphan node: the point of the view is
    // that something produced something else.
    await expect(page.locator('#lineage-graph .node')).not.toHaveCount(0);
    await expect(page.locator('#lineage-graph .edge')).not.toHaveCount(0);
    await expect(page.locator('#prov-link')).toBeVisible();
  });

  test('offers the same graph as W3C PROV-JSON', async ({ page, request }) => {
    await signIn(page, ACME);
    // A PROCESSED run specifically, as its sibling above does. The first row is
    // whatever sorts first, which under one dataset was processed and under
    // another was an OPEN run with nothing bound and therefore no lineage --
    // the test was passing on the shape of the fixture rather than on the
    // behaviour it names.
    await page
      .locator('#runs-table tbody tr', { has: page.locator('.badge.PROCESSED') })
      .first()
      .click();
    const boundEntry = page
      .locator('#run-detail tbody tr')
      .filter({ hasNot: page.locator('[data-artifact=""]') })
      .first();
    await boundEntry.click();
    await expect(page.locator('#lineage-graph svg')).toBeVisible();

    const href = await page.locator('#prov-link').getAttribute('href');
    expect(href).toContain('lineage.prov.json');

    const token = await page.locator('#token').inputValue();
    const response = await request.get(href ?? '', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.ok()).toBe(true);

    // Structurally PROV, not a bespoke shape wearing the name.
    const document = (await response.json()) as Record<string, unknown>;
    expect(document).toHaveProperty('prefix');
    expect(document).toHaveProperty('entity');
    expect(document).toHaveProperty('activity');
    expect(document).toHaveProperty('agent');
  });
});

test.describe('audit chain', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ACME);
    await page.click('nav button[data-view="audit"]');
  });

  test('streams events newest first, ordered numerically', async ({ page }) => {
    await expect(page.locator('#audit-table tbody tr')).not.toHaveCount(0);

    const sequences = (await page.locator('#audit-table tbody td.mono').allTextContents())
      .map((text) => Number(text.trim()))
      .filter((value) => Number.isFinite(value));

    expect(sequences.length).toBeGreaterThan(10);
    // Guards the alias-shadowing bug that made ORDER BY sort seq as text:
    // 9 would sort above 12 and the stream would read as nonsense.
    expect(sequences).toEqual([...sequences].sort((a, b) => b - a));
  });

  test('verifies the chain and reports the head', async ({ page }) => {
    await page.click('#verify-chain');

    await expect(page.locator('#verify-result')).toContainText('chain intact', {
      timeout: 20_000,
    });
    await expect(page.locator('#verify-result')).toContainText(/\d+ events/);
  });
});

test.describe('the read-only demo', () => {
  /**
   * Skipped unless the deployment under test has it switched on.
   *
   * `DEMO_MODE` and `AUTH_DEV_TOKEN_ENDPOINT` are mutually exclusive at startup
   * -- they are different sign-in mechanisms with different threat models, and
   * running both is a misconfiguration the service refuses to start with. The
   * stack this suite normally runs against enables the development endpoint,
   * because the seed and the twelve tests above sign in through it. So this test
   * describes the *published* deployment: seed with the development endpoint on,
   * then restart the API with `DEMO_MODE=true` and it off, which is exactly the
   * sequence a deploy performs.
   *
   * Probing rather than reading configuration: the browser cannot see the
   * server's environment, and a 404 from the endpoint is precisely the signal
   * the viewer itself acts on.
   */
  // globalSetup already probed both sign-in mechanisms, so this reads the
  // answer rather than asking again on every run.
  test.skip(
    !DEMO_SIGNIN,
    'demo mode is off on this deployment; run the API with DEMO_MODE=true and ' +
      'AUTH_DEV_TOKEN_ENDPOINT=false against an already-seeded database',
  );

  test('signs a stranger in and says the session is read-only', async ({ page }) => {
    await page.goto('/');
    // Nothing is typed. That is the point of the button: a visitor who was never
    // given a credential does not have one to type.
    await page.click('#demo-signin');

    await expect(page.locator('#error')).toHaveText('');
    await expect(page.locator('#token')).not.toHaveValue('');
    await expect(page.locator('#runs-table tbody tr')).not.toHaveCount(0);
    await expect(page.locator('#demo-banner')).toBeVisible();
    await expect(page.locator('#demo-banner')).toContainText('Read-only');
  });
});

test.describe('tenant isolation, as the browser sees it', () => {
  test.skip(!DEV_SIGNIN, 'a demo session only ever reaches one tenant');

  test('a northwind session sees only northwind runs', async ({ page }) => {
    await signIn(page, ACME);
    const acmeStudies = new Set(
      await page.locator('#runs-table tbody tr td:nth-child(3)').allTextContents(),
    );

    await page.evaluate(() => sessionStorage.clear());
    await signIn(page, NORTHWIND);
    const northwindStudies = new Set(
      await page.locator('#runs-table tbody tr td:nth-child(3)').allTextContents(),
    );

    expect(northwindStudies.size).toBeGreaterThan(0);
    // Compared on the study column rather than the id column: the viewer renders
    // only the first eight characters of a run id, and UUIDv7 encodes a
    // millisecond timestamp in exactly that prefix -- so ids minted by one seed
    // run share it and comparing them would assert nothing.
    for (const study of northwindStudies) {
      expect([...acmeStudies]).not.toContain(study);
    }
  });
});

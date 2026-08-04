import { type Page, expect, test } from '@playwright/test';

/**
 * The scenarios in `docs/WALKTHROUGH.md`, asserted.
 *
 * That document tells a stranger what to click and what they will see. Prose
 * like that rots silently: a label changes, a state disappears from the seed,
 * and the walkthrough keeps confidently describing a screen nobody can reach.
 * These tests are what stop that being discovered by the reader.
 *
 * They are deliberately about *what the visitor is told*, not about the
 * guarantees themselves — those are proved against a real PostgreSQL in
 * `test/integration`, where they belong. Here the question is narrower: does
 * the page say what the document says it says.
 */

// Which door this stack offers, decided in globalSetup. The two sign-in
// mechanisms are mutually exclusive by a startup check, so the suite takes
// whichever is open rather than only ever running against a development stack.
const DEMO_SIGNIN = process.env.ALIQUOT_E2E_DEMO_SIGNIN === 'true';

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  if (DEMO_SIGNIN) {
    await page.click('#demo-signin');
  } else {
    await page.locator('#own-credentials summary').click();
    await page.fill('#tenant', 'acme');
    await page.fill('#email', 'mara.okafor@acme.test');
    await page.click('#signin');
  }
  await expect(page.locator('#runs-table tbody tr')).not.toHaveCount(0);
}

test.describe('the landing page explains itself', () => {
  test('a visitor who has not signed in is told what this is and what to press', async ({
    page,
  }) => {
    // The failure this guards against is the one the viewer actually had: an
    // empty table, three credential inputs that a visitor cannot use, and
    // nothing saying what the product does.
    await page.goto('/');

    const intro = page.locator('#intro');
    await expect(intro).toBeVisible();
    await expect(intro).toContainText('What this is');
    await expect(intro).toContainText('What to click');

    // The one control a stranger can actually use is present and prominent.
    await expect(page.locator('#demo-signin')).toBeVisible();
    // The credential inputs are collapsed rather than competing with it.
    await expect(page.locator('#tenant')).toBeHidden();
  });

  test('the explainer steps down once there is data to look at', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('#intro')).toBeHidden();
  });

  test('every view carries a line of orientation', async ({ page }) => {
    await signIn(page);

    for (const view of ['runs', 'lineage', 'audit']) {
      await page.click(`nav button[data-view="${view}"]`);
      await expect(page.locator(`#view-${view} .view-hint`)).toBeVisible();
    }
  });
});

test.describe('walkthrough scenario 1 — declared, then uploaded', () => {
  test('a processed run shows a manifest with declared digests, all verified', async ({ page }) => {
    await signIn(page);

    await page
      .locator('#runs-table tbody tr', { has: page.locator('.badge.PROCESSED') })
      .first()
      .click();

    await expect(page.locator('#run-detail')).toContainText('Manifest');
    await expect(page.locator('#run-detail .kv')).toContainText('manifest digest');

    const states = await page.locator('#run-detail tbody .badge').allTextContents();
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((state) => state === 'VERIFIED')).toBe(true);
  });
});

test.describe('walkthrough scenario 2 — corruption quarantines the run', () => {
  test('the quarantined run names the artifact and both digests, and was never sealed', async ({
    page,
  }) => {
    await signIn(page);
    await page.selectOption('#filter-state', 'QUARANTINED');
    await expect(page.locator('#runs-table tbody tr')).not.toHaveCount(0);

    await page.locator('#runs-table tbody tr').first().click();
    const detail = page.locator('#run-detail');

    // Named artifact, not merely "something failed".
    await expect(detail).toContainText('REJECTED');
    // Both digests, so the reader can see the comparison that was made.
    await expect(detail).toContainText(/stored bytes hash to [0-9a-f]{64}/);
    await expect(detail).toContainText(/declared [0-9a-f]{64}/);
    // The claim that matters: it never got a seal, so nothing downstream can
    // have consumed it.
    await expect(detail.locator('.kv')).toContainText('sealed');
    await expect(detail.locator('.kv')).toContainText('—');
  });
});

test.describe('walkthrough scenario 3 — correction by superseding', () => {
  test('a later run supersedes it with a reason, and the original is still there', async ({
    page,
  }) => {
    await signIn(page);

    // Find the run carrying a supersedes pointer by opening processed runs
    // until one shows it -- the same way the document tells a reader to.
    const rows = page.locator('#runs-table tbody tr', { has: page.locator('.badge.PROCESSED') });
    const count = await rows.count();

    let found = false;
    for (let index = 0; index < count; index += 1) {
      await rows.nth(index).click();
      await expect(page.locator('#run-detail')).toContainText('Manifest');
      if ((await page.locator('#run-detail .kv').innerText()).includes('supersedes')) {
        found = true;
        break;
      }
    }

    expect(found, 'no run in the seeded dataset supersedes another').toBe(true);
    await expect(page.locator('#run-detail .kv')).toContainText('re-transferred');
  });
});

test.describe('walkthrough scenario 5 — provenance nobody typed', () => {
  test('a verified artifact traces back to its instrument and operator', async ({ page }) => {
    await signIn(page);

    await page
      .locator('#runs-table tbody tr', { has: page.locator('.badge.PROCESSED') })
      .first()
      .click();
    await expect(page.locator('#run-detail')).toContainText('Manifest');

    await page
      .locator('#run-detail tbody tr')
      .filter({ hasNot: page.locator('[data-artifact=""]') })
      .first()
      .click();

    await expect(page.locator('#view-lineage')).toHaveClass(/active/);
    await expect(page.locator('#lineage-graph svg')).toBeVisible();

    // The document promises the graph reaches people and machines, not just
    // files. An artifact-only graph would satisfy "it rendered" and fail the
    // claim.
    const graph = await page.locator('#lineage-graph').innerText();
    expect(graph).toMatch(/operator/i);
    expect(graph).toMatch(/1\.0\.0/); // a processor version

    await expect(page.locator('#lineage-graph .node-agent')).not.toHaveCount(0);
    await expect(page.locator('#lineage-graph .node-activity')).not.toHaveCount(0);
    await expect(page.locator('#prov-link')).toBeVisible();
  });
});

test.describe('walkthrough scenario 7 — the audit chain', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.click('nav button[data-view="audit"]');
    await expect(page.locator('#audit-table tbody tr')).not.toHaveCount(0);
  });

  test('verification reports the chain intact and names the head', async ({ page }) => {
    await page.click('#verify-chain');
    await expect(page.locator('#verify-result')).toContainText('chain intact', { timeout: 25_000 });
    await expect(page.locator('#verify-result')).toContainText(/\d+ events/);
  });

  test('the action filter narrows the stream to one family', async ({ page }) => {
    // On a public deployment every visitor mints a session, so without this the
    // domain events the view exists to show are pushed off the first page.
    await page.selectOption('#filter-action', 'run');
    await expect(page.locator('#audit-table tbody tr')).not.toHaveCount(0);

    // The second cell specifically: the row renders both the action and the
    // hash inside <code>, so a bare `code` selector also matches every digest.
    const actions = await page
      .locator('#audit-table tbody tr td:nth-child(2) code')
      .allTextContents();
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action.startsWith('run.'))).toBe(true);
  });
});

test.describe('walkthrough scenario 9 — isolation, as the browser sees it', () => {
  test('an identifier from outside the session is 404, not 403', async ({ page, request }) => {
    await signIn(page);
    const token = await page.locator('#token').inputValue();

    // A well-formed identifier that belongs to nothing this session can see.
    // 403 would confirm it is real and belongs to somebody.
    const response = await request.get('/v1/runs/019fc903-0000-7000-8000-000000000000', {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status()).toBe(404);
  });
});

test.describe('walkthrough scenario 4 — the demo session cannot write', () => {
  test.skip(!DEMO_SIGNIN, 'needs a demo session; the dev stack signs in as a full user');

  test('every mutating verb is refused', async ({ page, request }) => {
    await signIn(page);
    const token = await page.locator('#token').inputValue();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const studies = await request.get('/v1/studies', { headers });
    const studyId = ((await studies.json()) as { items: { id: string }[] }).items[0]?.id ?? '';

    const registration = await request.post(`/v1/studies/${studyId}/runs`, {
      headers: { ...headers, 'idempotency-key': 'walkthrough-readonly-probe' },
      data: {},
    });
    expect(registration.status()).toBe(403);

    const instrument = await request.post('/v1/instruments', { headers, data: {} });
    expect(instrument.status()).toBe(403);
  });
});

import { expect, test } from '@playwright/test';

/**
 * The one view that writes, driven the way a visitor drives it.
 *
 * This is the only place in the repository where the whole ingestion lifecycle
 * is exercised through a browser: bytes generated and hashed client-side, a
 * presigned cross-origin PUT straight to the object store, read-back
 * verification, sealing, a worker in another process, and the audit chain that
 * records all of it. `test/integration` proves each guarantee against a real
 * PostgreSQL; what only a browser can prove is that the path a stranger takes
 * through them actually connects end to end.
 *
 * Two failures in particular are invisible everywhere else and would reach a
 * visitor as an unexplained spinner:
 *
 *   - a presigned URL signed for a host the browser cannot resolve, which is
 *     the default shape of a `docker compose up` and the reason
 *     `STORAGE_PUBLIC_ENDPOINT` exists;
 *   - a bucket whose CORS policy does not expose `ETag`, so the PUT succeeds
 *     and completion cannot name the part that was stored.
 *
 * Neither is reachable from Node, because neither is enforced by anything but a
 * browser.
 */

const SANDBOX = process.env.ALIQUOT_E2E_SANDBOX === 'true';

// The clean path waits on a worker in another process: seal, claim, read the
// object back, run two processors, record the derivations. Generous, because
// the failure this guards against is a broken wire, and a suite that flakes on
// a slow machine gets muted rather than fixed.
const LIFECYCLE_TIMEOUT = 180_000;

test.describe('the sandbox', () => {
  test.skip(!SANDBOX, 'this deployment runs with SANDBOX_MODE off');
  test.describe.configure({ timeout: LIFECYCLE_TIMEOUT });

  test.beforeEach(async ({ page }) => {
    // Deliberately never signs in. The whole claim of this tab is that a
    // stranger with no account reaches it, so a fixture that authenticated
    // first would be testing something nobody does.
    await page.goto('/');
    await page.click('nav button[data-view="sandbox"]');
    await page.click('#sandbox-start');
    await expect(page.locator('#sandbox-session')).toBeVisible();
  });

  test('provisioning hands over a whole tenant, with a clock on it', async ({ page }) => {
    // A slug that was minted for this visitor, not the seeded tenant.
    await expect(page.locator('#sandbox-slug')).toHaveText(/^sandbox-[0-9a-f]{8}$/);
    await expect(page.locator('#sandbox-quota')).toContainText('runs');

    // The countdown is the promise that this does not accumulate. If it is not
    // running, nothing on the page says the tenant is temporary.
    const countdown = page.locator('#sandbox-countdown');
    await expect(countdown).toHaveText(/^\d+:\d{2}$/);
    const first = await countdown.textContent();
    await expect(countdown).not.toHaveText(first ?? '', { timeout: 5_000 });

    // Generated here, hashed here. The digest is the declaration everything
    // downstream is checked against, so it has to exist before anything moves.
    await expect(page.locator('#frame-digest')).toHaveText(/^[0-9a-f]{64}$/);
    await expect(page.locator('#sandbox-canvas')).toBeVisible();
  });

  test('a clean run reaches PROCESSED, and its own chain verifies', async ({ page }) => {
    await page.click('#sandbox-run');

    // Every step, in order, green. Asserted as a set rather than one at a time
    // because a run that stops halfway leaves the rest `pending`, and the useful
    // failure message names which ones never ran.
    const steps = ['register', 'begin', 'put', 'parts', 'complete', 'seal', 'processing'];
    for (const step of steps) {
      await expect(page.locator(`#step-${step}`), `step ${step}`).toHaveClass(/done/, {
        timeout: LIFECYCLE_TIMEOUT,
      });
    }

    // The bytes went from the browser to the object store directly. If the
    // presigned URL had pointed at a host only the API can resolve, `put` would
    // have failed above -- this asserts the claim the step makes about itself.
    await expect(page.locator('#step-put .step-call')).toContainText('cross-origin, presigned');

    // The claim completion makes is not a word, it is an equality: the digest of
    // what the service read back out of the store is the digest this page
    // declared before any byte moved. Asserting the two strings match is the
    // only assertion here that could not also be satisfied by a label.
    await expect(page.locator('#step-complete .digest')).toHaveText(
      (await page.locator('#frame-digest').textContent()) ?? '',
    );
    await expect(page.locator('#step-seal')).toContainText('SEALED');
    await expect(page.locator('#step-processing')).toContainText('PROCESSED');

    // Provenance nobody typed: a graph that reaches machines and people, not
    // just files. An artifact-only graph would satisfy "it rendered".
    await expect(page.locator('#step-lineage')).toHaveClass(/done/);
    await expect(page.locator('#sandbox-graph svg')).toBeVisible();
    await expect(page.locator('#sandbox-graph .node-activity')).not.toHaveCount(0);

    // The chain, from its genesis. `seq 1` is this tenant being created, which
    // is the one thing the seeded demo structurally cannot show.
    await expect(page.locator('#step-audit')).toHaveClass(/done/);
    const sequences = await page.locator('#step-audit tbody td:first-child').allTextContents();
    expect(sequences).toContain('1');

    // And the question the whole tab builds towards, asked about a chain the
    // visitor watched being written.
    await expect(page.locator('#step-verify')).toHaveClass(/done/);
    await expect(page.locator('#step-verify')).toContainText('intact');
    await expect(page.locator('#step-verify')).toContainText(/head hash/i);
  });

  test('one flipped byte is refused, and the run can never be sealed', async ({ page }) => {
    await page.check('#sandbox-corrupt');
    await page.click('#sandbox-run');

    // The upload itself succeeds. That is the point: the object store stored
    // exactly what it was handed, and what it was handed looked fine.
    await expect(page.locator('#step-put'), 'the corrupted PUT still succeeds').toHaveClass(
      /done/,
      { timeout: LIFECYCLE_TIMEOUT },
    );

    // Read-back verification is the only thing that catches it.
    const complete = page.locator('#step-complete');
    await expect(complete).toHaveClass(/failed/, { timeout: LIFECYCLE_TIMEOUT });
    await expect(complete).toContainText('Stored bytes do not match the declared digest');

    // Both digests, so a reader can see the comparison that was made -- and they
    // must actually differ, or the assertion above would pass against a page
    // that printed the same number twice.
    const digests = await complete.locator('.kv .digest').allTextContents();
    expect(digests.length).toBeGreaterThanOrEqual(2);
    expect(digests[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(digests[0]).not.toBe(digests[1]);

    await expect(complete).toContainText('QUARANTINED');
    await expect(complete).toContainText('never');

    // Terminal, and everything downstream says so rather than sitting pending.
    for (const step of ['seal', 'processing', 'lineage', 'audit', 'verify']) {
      await expect(page.locator(`#step-${step}`), `step ${step}`).toHaveClass(/skipped/);
    }
    await expect(page.locator('#step-seal')).toContainText('supersedes');
  });

  test('the sandbox credential is separate from the signed-in session', async ({ page }) => {
    // Needs a second way in to hold two credentials at once. The public
    // deployment has the demo sign-in instead, which this would have to drive
    // differently; the property is the same either way and is worth asserting
    // once rather than twice.
    test.skip(
      process.env.ALIQUOT_E2E_DEV_SIGNIN !== 'true',
      'needs the development sign-in to hold a second session',
    );

    // Both can be held at once, and the tab must not overwrite the session the
    // rest of the page is using -- a visitor who signs in to read the seeded
    // data and then starts a sandbox would otherwise lose the first.
    const before = await page.locator('#token').inputValue();

    await page.click('nav button[data-view="runs"]');
    const detailsSummary = page.locator('#own-credentials summary');
    if (await detailsSummary.isVisible()) await detailsSummary.click();
    await page.fill('#tenant', 'acme');
    await page.fill('#email', 'mara.okafor@acme.test');
    await page.click('#signin');
    await expect(page.locator('#runs-table tbody tr')).not.toHaveCount(0);

    const after = await page.locator('#token').inputValue();
    expect(after).not.toBe(before);

    // The sandbox survived it, holding its own credential.
    await page.click('nav button[data-view="sandbox"]');
    await expect(page.locator('#sandbox-session')).toBeVisible();
    await expect(page.locator('#sandbox-slug')).toHaveText(/^sandbox-[0-9a-f]{8}$/);
  });
});

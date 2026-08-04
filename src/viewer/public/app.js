// The viewer. Plain ES modules, no framework, no build step (ADR-0018).
//
// Three of its four views read and nothing else: the provenance graph and the
// audit chain with its verification result, over whatever session was signed in.
// The fourth writes, and is the only part of this file that does -- it drives a
// full acquisition through a throwaway sandbox tenant so that a visitor can
// watch the verification path refuse bytes rather than read a claim that it
// would. See the "try it yourself" section below.

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  token: sessionStorage.getItem('aliquot.token') ?? '',
  // Whether the session in hand came from the demo endpoint. Stored alongside
  // the token rather than decoded out of it: the claim is there, but a viewer
  // that parses JWTs to decide what to render starts looking like a viewer that
  // trusts them.
  demo: sessionStorage.getItem('aliquot.demo') === 'true',
  runsCursor: null,
  auditCursor: null,
  /**
   * The sandbox session, which is a *second* identity and is deliberately kept
   * apart from the first.
   *
   * A visitor arrives, presses "Try the demo" and holds a read-only session on
   * the seeded tenant; then they start a sandbox and hold an operator session on
   * a tenant that did not exist a moment ago. Overwriting `token` with the
   * second would silently empty the Runs table they were just reading, and
   * pasting the sandbox token into `#token` would make the credential inputs
   * describe a session the visitor never typed. So the sandbox token lives here,
   * is passed explicitly to every call the sandbox makes, and is never written to
   * `state.token`, `#token`, or `aliquot.token`.
   *
   * Kept in sessionStorage under its own key so that a reload mid-run does not
   * strand a live tenant with no way back to it.
   */
  sandbox: null,
  /** The generated PNG awaiting upload: bytes, digest, dimensions. */
  frame: null,
};

$('#token').value = state.token;

/**
 * The explainer is shown until there is a session and hidden once there is one.
 * It exists for the visitor who arrives at an empty table with no idea what a
 * "run" is; once they can see runs, the runs are the better explanation.
 */
function showIntro(visible) {
  const intro = $('#intro');
  if (intro) intro.hidden = !visible;
}

showIntro(state.token === '');
$('#demo-banner').hidden = !state.demo;

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

/**
 * `token` overrides the signed-in session for this one call, and `null` sends no
 * credential at all -- provisioning a sandbox is a public route and must not
 * carry a demo token that would only give it something to reject.
 *
 * `quiet` keeps the failure out of the footer. It is for the calls whose refusal
 * is rendered in full where it happened; a run that is quarantined exactly as
 * intended should not also light up a page-level error, because that reads as
 * the page being broken rather than the service working.
 */
async function api(path, options = {}) {
  const { token = state.token, quiet = false, ...init } = options;
  $('#error').textContent = '';

  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    // Every error this service produces is RFC 9457 problem+json, so there is
    // exactly one shape to render rather than a guess per endpoint.
    let detail = `${response.status} ${response.statusText}`;
    let problem = null;
    try {
      problem = await response.json();
      detail = problem.detail ?? problem.title ?? detail;
      if (problem.brokenAtSeq !== undefined) detail += ` (seq ${problem.brokenAtSeq})`;
    } catch {
      /* not json; the status line is all we have */
    }
    if (!quiet) $('#error').textContent = detail;
    // The status rides along on the error so a caller can distinguish "this
    // deployment does not have that endpoint" from "that endpoint refused this
    // request", which are different things to tell a reader. The whole problem
    // document rides along too, because the extension members are the useful
    // part -- which quota, which digest, which sequence number -- and reducing
    // them to one sentence throws that away.
    const error = new Error(detail);
    error.status = response.status;
    error.problem = problem;
    throw error;
  }

  return response.status === 204 ? null : response.json();
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

function adoptSession(token, { demo, whoami }) {
  state.token = token;
  state.demo = demo;
  sessionStorage.setItem('aliquot.token', token);
  sessionStorage.setItem('aliquot.demo', String(demo));
  $('#token').value = token;
  $('#whoami').textContent = whoami;
  $('#demo-banner').hidden = !demo;
}

$('#token').addEventListener('change', (event) => {
  state.token = event.target.value.trim();
  sessionStorage.setItem('aliquot.token', state.token);
  // A pasted token is not a demo session until something says it is, and
  // nothing here can say so without decoding it. Clearing the flag keeps the
  // banner from outliving the session it described.
  state.demo = false;
  sessionStorage.setItem('aliquot.demo', 'false');
  $('#demo-banner').hidden = true;
});

$('#signin').addEventListener('click', async () => {
  const email = $('#email').value.trim();
  // The tenant is required, not inferred. An email address is unique within a
  // tenant and not across them, so two tenants can both hold
  // operator@example.test and resolving on the address alone would either pick
  // one arbitrarily or need a cross-tenant lookup -- which would turn a
  // dev-only endpoint into a way to probe which addresses exist elsewhere.
  const tenantSlug = $('#tenant').value.trim();
  if (!email || !tenantSlug) {
    $('#error').textContent = 'Both a tenant slug and an email are required.';
    return;
  }
  const result = await api('/v1/auth/token', {
    method: 'POST',
    body: JSON.stringify({ email, tenantSlug }),
  });
  // The response nests the principal under `user`; reading result.displayName
  // silently yielded undefined and fell back to the email every time.
  adoptSession(result.token, { demo: false, whoami: result.user?.displayName ?? email });
  await loadRuns(true);
});

// The whole of the demo sign-in. No body, because the endpoint takes none: the
// principal is fixed by the deployment's configuration, so there is nothing for
// this page to choose and nothing for a visitor to supply.
$('#demo-signin').addEventListener('click', async () => {
  let result;
  try {
    result = await api('/v1/auth/demo', { method: 'POST' });
  } catch (error) {
    // A deployment without DEMO_MODE answers 404, exactly as it does for a route
    // that does not exist. Saying so on the button is more use to a reader than
    // a problem document in the footer they have to scroll to. Any other
    // failure -- a rate limit, an unseeded dataset -- is transient or
    // actionable, so the button stays live for it.
    if (error.status === 404) {
      $('#demo-signin').disabled = true;
      $('#demo-signin').textContent = 'Demo not enabled here';
    }
    return;
  }

  adoptSession(result.token, {
    demo: result.demo === true,
    whoami: result.user?.displayName ?? 'demo',
  });
  await loadRuns(true);
});

// ---------------------------------------------------------------------------
// navigation
// ---------------------------------------------------------------------------

$$('nav button').forEach((button) => {
  button.addEventListener('click', () => {
    $$('nav button').forEach((b) => b.classList.toggle('active', b === button));
    $$('.view').forEach((view) =>
      view.classList.toggle('active', view.id === `view-${button.dataset.view}`),
    );
    // The explainer orients a visitor who has not signed in yet, and the sandbox
    // tab does its own orienting. Stacked, the two push the button a visitor came
    // for below the fold.
    showIntro(state.token === '' && button.dataset.view !== 'sandbox');

    if (button.dataset.view === 'audit') void loadAudit(true);
    if (button.dataset.view === 'sandbox') void refreshSandbox();
  });
});

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

async function loadRuns(reset) {
  showIntro(false);
  if (reset) {
    state.runsCursor = null;
    $('#runs-table tbody').innerHTML = '';
  }

  const params = new URLSearchParams({ limit: '25' });
  const filter = $('#filter-state').value;
  if (filter) params.set('state', filter);
  if (state.runsCursor) params.set('cursor', state.runsCursor);

  const page = await api(`/v1/runs?${params}`);
  const body = $('#runs-table tbody');

  for (const run of page.items) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><code>${short(run.id)}</code></td>
      <td><span class="badge ${run.state}">${run.state}</span></td>
      <td>${escapeHtml(run.studySlug ?? '')}</td>
      <td>${escapeHtml(run.instrumentSlug ?? '')}</td>
      <td class="muted">${run.acquiredAt ? new Date(run.acquiredAt).toISOString().slice(0, 16).replace('T', ' ') : '—'}</td>
      <td class="muted">${run.artifactCount ?? run.manifest?.length ?? '—'}</td>`;
    row.addEventListener('click', () => void showRun(run.id));
    body.append(row);
  }

  state.runsCursor = page.nextCursor;
  $('#runs-more').hidden = !page.nextCursor;
}

async function showRun(runId) {
  const run = await api(`/v1/runs/${runId}`);
  const manifest = run.manifest ?? [];

  $('#run-detail').innerHTML = `
    <div class="panel">
      <h3>Run</h3>
      <dl class="kv">
        <dt>id</dt><dd>${run.id}</dd>
        <dt>state</dt><dd><span class="badge ${run.state}">${run.state}</span></dd>
        <dt>manifest digest</dt><dd>${run.manifestDigest ?? ''}</dd>
        <dt>registered</dt><dd>${run.registeredAt ?? ''}</dd>
        <dt>sealed</dt><dd>${run.sealedAt ?? '—'}</dd>
        ${run.supersedesRunId ? `<dt>supersedes</dt><dd>${run.supersedesRunId} — ${escapeHtml(run.supersedeReason ?? '')}</dd>` : ''}
        ${run.supersededByRunId ? `<dt>superseded by</dt><dd>${run.supersededByRunId}</dd>` : ''}
        ${run.quarantineReason ? `<dt>quarantine</dt><dd>${escapeHtml(run.quarantineReason)}</dd>` : ''}
      </dl>
    </div>
    <div class="panel">
      <h3>Manifest (${manifest.length})</h3>
      <table>
        <thead><tr><th>Logical name</th><th>State</th><th>Size</th><th>Digest</th></tr></thead>
        <tbody>${manifest
          .map(
            (entry) => `<tr data-artifact="${entry.artifactId ?? ''}">
              <td><code>${escapeHtml(entry.logicalName)}</code></td>
              <td><span class="badge ${entry.verificationState}">${entry.verificationState}</span></td>
              <td class="muted mono">${formatBytes(entry.declaredSize)}</td>
              <td><code>${short(entry.declaredDigest, 16)}</code></td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>
    </div>`;

  // Clicking a verified manifest entry jumps straight to its lineage. This is
  // the path a reviewer actually walks: run -> artifact -> what produced it.
  $$('#run-detail tbody tr').forEach((row) => {
    const artifactId = row.dataset.artifact;
    if (!artifactId) return;
    row.addEventListener('click', () => {
      $('#lineage-artifact').value = artifactId;
      $$('nav button')
        .find((b) => b.dataset.view === 'lineage')
        .click();
      void loadLineage();
    });
  });
}

$('#reload-runs').addEventListener('click', () => void loadRuns(true));
$('#filter-state').addEventListener('change', () => void loadRuns(true));
$('#runs-more').addEventListener('click', () => void loadRuns(false));

// ---------------------------------------------------------------------------
// lineage
// ---------------------------------------------------------------------------

async function loadLineage() {
  const artifactId = $('#lineage-artifact').value.trim();
  if (!artifactId) return;

  const direction = $('#lineage-direction').value;
  const graph = await api(`/v1/artifacts/${artifactId}/lineage?direction=${direction}`);

  $('#prov-link').hidden = false;
  $('#prov-link').href = `/v1/artifacts/${artifactId}/lineage.prov.json?direction=${direction}`;

  renderGraph(graph);

  if (graph.truncated) {
    $('#lineage-detail').innerHTML =
      `<div class="panel"><h3>Note</h3><p class="muted">Traversal stopped at the depth cap (${graph.maxDepth}). The graph shown is complete to that depth, not the full ancestry.</p></div>`;
  } else {
    $('#lineage-detail').innerHTML = '';
  }
}

/**
 * Layered left-to-right layout by graph depth.
 *
 * Deliberately not a force-directed layout: provenance is a DAG with a
 * meaningful direction, and a physics simulation obscures the one thing a
 * reader is here to see, which is what came from what.
 *
 * The container is a parameter so the sandbox timeline can draw its graph inside
 * the step that produced it. One renderer, two places it can land; a second
 * renderer would be two chances to disagree about what an edge means.
 */
function renderGraph(graph, container = $('#lineage-graph')) {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  if (nodes.length === 0) {
    container.innerHTML = '<p class="muted" style="padding:16px">No lineage found.</p>';
    return;
  }

  const columns = new Map();
  for (const node of nodes) {
    const depth = node.depth ?? 0;
    if (!columns.has(depth)) columns.set(depth, []);
    columns.get(depth).push(node);
  }

  const NODE_W = 210;
  const NODE_H = 46;
  const GAP_X = 90;
  const GAP_Y = 18;

  const positions = new Map();
  const depths = [...columns.keys()].sort((a, b) => a - b);

  depths.forEach((depth, columnIndex) => {
    columns.get(depth).forEach((node, rowIndex) => {
      positions.set(node.id, {
        x: 20 + columnIndex * (NODE_W + GAP_X),
        y: 20 + rowIndex * (NODE_H + GAP_Y),
      });
    });
  });

  const width = 40 + depths.length * (NODE_W + GAP_X);
  const height = 40 + Math.max(...[...columns.values()].map((c) => c.length)) * (NODE_H + GAP_Y);

  const edgeSvg = edges
    .map((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return '';
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const mid = (x1 + x2) / 2;
      return `<path class="edge" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}" marker-end="url(#arrow)" />
        <text class="edge-label" x="${mid}" y="${(y1 + y2) / 2 - 4}" text-anchor="middle">${escapeHtml(edge.type)}</text>`;
    })
    .join('');

  const nodeSvg = nodes
    .map((node) => {
      const position = positions.get(node.id);
      return `<g class="node node-${node.kind}" transform="translate(${position.x},${position.y})">
        <rect width="${NODE_W}" height="${NODE_H}" rx="5" />
        <text x="10" y="19">${escapeHtml(truncate(node.label, 28))}</text>
        <text class="node-sub" x="10" y="34">${escapeHtml(truncate(node.sublabel ?? node.kind, 32))}</text>
      </g>`;
    })
    .join('');

  container.innerHTML = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#2a3543" />
        </marker>
      </defs>
      ${edgeSvg}
      ${nodeSvg}
    </svg>`;
}

$('#load-lineage').addEventListener('click', () => void loadLineage());

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

async function loadAudit(reset) {
  if (reset) {
    state.auditCursor = null;
    $('#audit-table tbody').innerHTML = '';
  }

  // The filter selects a *family* of actions (`run.*`), and the API filters on
  // one exact action, so the narrowing happens here. That means a page can
  // contain no matches at all -- on a public deployment every visitor mints a
  // session, so `session.issued` can fill an entire page and a filter that
  // stopped after one fetch would show an empty table while matching events sat
  // on the next. So: keep pulling pages until something matches or the pages
  // run out, bounded so a filter with no matches anywhere still terminates.
  const prefix = $('#filter-action')?.value ?? '';
  const body = $('#audit-table tbody');
  const MAX_PAGES = 8;

  let matched = 0;
  let page = null;

  for (let fetched = 0; fetched < MAX_PAGES; fetched += 1) {
    const params = new URLSearchParams({ limit: '50' });
    if (state.auditCursor) params.set('cursor', state.auditCursor);

    page = await api(`/v1/audit?${params}`);
    state.auditCursor = page.nextCursor;

    const shown = prefix
      ? page.items.filter((event) => event.action.startsWith(`${prefix}.`))
      : page.items;

    for (const event of shown) {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="mono">${event.seq}</td>
        <td><code>${escapeHtml(event.action)}</code></td>
        <td class="muted">${escapeHtml(event.actorLabel)} <span class="muted">(${event.actorType})</span></td>
        <td class="muted mono">${escapeHtml(event.targetType)} ${short(event.targetId)}</td>
        <td class="muted">${event.occurredAt}</td>
        <td><code title="${event.hash}">${short(event.hash, 12)}</code></td>`;
      body.append(row);
    }

    matched += shown.length;
    if (matched > 0 || state.auditCursor === null) break;
  }

  $('#audit-more').hidden = state.auditCursor === null;

  if (matched === 0 && body.childElementCount === 0) {
    body.innerHTML =
      '<tr><td colspan="6" class="muted">No matching events in the recent history.</td></tr>';
  }
}

$('#reload-audit').addEventListener('click', () => void loadAudit(true));
$('#filter-action')?.addEventListener('change', () => void loadAudit(true));
$('#audit-more').addEventListener('click', () => void loadAudit(false));

$('#verify-chain').addEventListener('click', async () => {
  const result = $('#verify-result');
  result.textContent = 'verifying…';
  result.className = 'muted';

  try {
    const verification = await api('/v1/audit/verify', { method: 'POST', body: '{}' });
    if (verification.ok) {
      result.textContent = `chain intact — ${verification.eventsVerified} events, head ${short(verification.headHash, 12)}`;
      result.className = '';
      result.style.color = 'var(--ok)';
    } else {
      // Naming the exact sequence number is the whole point of the chain. A
      // verifier that only says "something is wrong" tells an auditor nothing
      // they can act on.
      result.textContent = `BROKEN at seq ${verification.brokenAtSeq} — ${verification.reason}`;
      result.style.color = 'var(--bad)';
    }
  } catch {
    result.textContent = '';
  }
});

// ---------------------------------------------------------------------------
// try it yourself
//
// The only part of this file that writes. It drives the documented ingestion
// API from the browser -- register, presign, PUT, record, complete, seal, poll,
// read back -- inside a tenant that is created on demand and deleted on a timer.
//
// Two things about it are load-bearing rather than presentational. The bytes go
// from this page straight to object storage on a presigned URL and never pass
// through the API, which is the path an instrument takes and the reason a 300 GB
// stack does not have to be proxied through a Node process. And the digest is
// computed here, over bytes this page generated, before anything is declared --
// so when verification refuses a corrupted transfer it is refusing a number the
// visitor watched being produced rather than one the server chose.
// ---------------------------------------------------------------------------

const SANDBOX_KEY = 'aliquot.sandbox';

const FRAME_NAME = 'ch0/frame-001.png';
const FRAME_MEDIA_TYPE = 'image/png';

/** Halved by "generate a smaller frame" if a deployment's per-artifact cap is tighter. */
const FRAME_SIZE = { width: 512, height: 384 };

const PROCESSING_POLL_MS = 600;
const PROCESSING_POLL_ATTEMPTS = 60;

/**
 * The nine steps, laid out before the first one runs.
 *
 * All of them are drawn up front rather than appended as they complete, because
 * the shape of the lifecycle is itself the thing being explained: a visitor
 * should be able to see, at the moment they press the button, that verification
 * comes before sealing and that sealing comes before anything is derived.
 */
const LIFECYCLE_STEPS = [
  ['register', 'Register the run'],
  ['begin', 'Open the upload'],
  ['put', 'Send the bytes to object storage'],
  ['parts', 'Record the parts'],
  ['complete', 'Complete, and verify'],
  ['seal', 'Seal the run'],
  ['processing', 'Processing'],
  ['lineage', 'Provenance'],
  ['audit', 'The audit chain'],
  ['verify', 'Verify the chain'],
];

/** Restore a sandbox across a reload rather than stranding a live tenant. */
try {
  const saved = sessionStorage.getItem(SANDBOX_KEY);
  if (saved !== null) state.sandbox = JSON.parse(saved);
} catch {
  // A malformed entry is not worth failing the page over, and nothing else
  // depends on it: the visitor simply starts another sandbox.
  sessionStorage.removeItem(SANDBOX_KEY);
}

let countdownTimer = null;

function rememberSandbox(session) {
  state.sandbox = session;
  if (session === null) sessionStorage.removeItem(SANDBOX_KEY);
  else sessionStorage.setItem(SANDBOX_KEY, JSON.stringify(session));
}

/**
 * Draw whatever is known about the current sandbox.
 *
 * Called on tab entry as well as after each run, so a visitor coming back to the
 * tab sees a live countdown and current usage rather than whatever was true when
 * they left it.
 */
async function refreshSandbox() {
  const held = state.sandbox !== null;
  $('#sandbox-offer').hidden = held;
  $('#sandbox-session').hidden = !held;
  $('#sandbox-artifact').hidden = !held;
  if (!held) return;

  renderSandbox(state.sandbox.sandbox);

  // Usage is read back rather than counted here. The quota that matters is the
  // one the guard enforces, and a number this page maintained itself would drift
  // from it at the first refused request.
  try {
    const status = await api('/v1/sandbox', { token: state.sandbox.token, quiet: true });
    state.sandbox.sandbox = status;
    rememberSandbox(state.sandbox);
    renderSandbox(status);
  } catch (error) {
    // 401 once the token has expired, 403 once the tenant has been reaped and
    // the session resolves to nothing. Either way the stored session is spent,
    // and keeping it leaves a countdown ticking against a tenant that is gone.
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      $('#sandbox-used').textContent = 'this sandbox is over';
      $('#sandbox-run').disabled = true;
      return;
    }
    $('#sandbox-used').textContent = 'unavailable';
  }

  if (state.frame === null) await generateFrame(FRAME_SIZE.width, FRAME_SIZE.height);
}

function renderSandbox(descriptor) {
  $('#sandbox-slug').textContent = descriptor.tenantSlug;
  $('#sandbox-tenant').textContent = descriptor.tenantId;
  $('#sandbox-study').textContent = short(descriptor.studyId, 13);
  $('#sandbox-instrument').textContent = short(descriptor.instrumentId, 13);
  $('#sandbox-expires').textContent = `at ${new Date(descriptor.expiresAt).toISOString().slice(11, 19)}Z`;
  $('#sandbox-quota').textContent =
    `${descriptor.quota.maxRuns} runs · ${formatBytes(descriptor.quota.maxArtifactBytes)} per ` +
    `artifact · ${formatBytes(descriptor.quota.maxTotalBytes)} in total`;
  $('#sandbox-used').textContent =
    descriptor.used === undefined
      ? 'nothing yet'
      : `${descriptor.used.runs} run(s) · ${formatBytes(descriptor.used.totalBytes)}`;
  startCountdown(descriptor.expiresAt);
}

/**
 * The countdown runs to `sandbox.expiresAt`, which is not the token's expiry.
 *
 * They are separate clocks on purpose, and the one a visitor needs to watch is
 * the one after which their work stops existing.
 */
function startCountdown(expiresAt) {
  if (countdownTimer !== null) clearInterval(countdownTimer);
  const deadline = new Date(expiresAt).getTime();

  const tick = () => {
    const remaining = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    const element = $('#sandbox-countdown');
    element.classList.toggle('expired', remaining === 0);

    if (remaining === 0) {
      element.textContent = 'expired';
      $('#sandbox-run').disabled = true;
      $('#sandbox-run-note').textContent =
        'This sandbox has expired and its tenant is being deleted. Start another to keep going.';
      clearInterval(countdownTimer);
      countdownTimer = null;
      return;
    }

    element.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  };

  tick();
  countdownTimer = setInterval(tick, 1000);
}

async function startSandbox() {
  const note = $('#sandbox-start-note');
  note.className = 'muted';
  note.textContent = 'creating a tenant…';

  try {
    // No credential at all: provisioning is a public route, and presenting a
    // demo session here would only give an unrelated endpoint something to
    // reject.
    const issued = await api('/v1/sandbox', { method: 'POST', token: null, quiet: true });
    rememberSandbox({ token: issued.token, sandbox: issued.sandbox });
    note.textContent = '';
    $('#sandbox-timeline').hidden = true;
    $('#sandbox-timeline').innerHTML = '';
    state.frame = null;
    await refreshSandbox();
  } catch (error) {
    note.className = 'error';

    if (error.status === 404) {
      // Absent rather than forbidden when switched off, exactly as the demo
      // sign-in is: a 403 would confirm the route exists and is merely disabled.
      // Saying so on the button beats a problem document in the footer.
      $('#sandbox-start').disabled = true;
      $('#sandbox-start').textContent = 'Sandboxes are not enabled here';
      note.textContent = 'This deployment runs with SANDBOX_MODE off.';
      return;
    }
    if (error.status === 429) {
      note.textContent =
        `${error.problem?.detail ?? error.message} Each admitted request creates a whole tenant, ` +
        'so this limit is tighter than the one on the demo sign-in.';
      return;
    }
    note.textContent = error.problem?.detail ?? error.message;
  }
}

// ---------------------------------------------------------------------------
// the artifact, made here
// ---------------------------------------------------------------------------

/**
 * A real PNG, drawn in the browser and hashed in the browser.
 *
 * Real because `metadata-extract` recognises PNG by its magic bytes and reads
 * the dimensions out of the IHDR chunk, so the derivation at the end of the run
 * is work done on these bytes. A placeholder would exercise the same dispatch
 * machinery and demonstrate nothing about it.
 *
 * The per-pixel noise is not decoration. PNG is losslessly compressed, so a
 * synthetic field of view is a few kilobytes; the noise is what makes the object
 * a few hundred kilobytes and therefore worth transferring. It also makes every
 * frame unique, which keeps each run a genuine upload rather than a
 * content-addressed deduplication of the previous one.
 */
async function generateFrame(width, height) {
  const canvas = $('#sandbox-canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  context.fillStyle = '#04070c';
  context.fillRect(0, 0, width, height);

  for (let index = 0; index < 130; index += 1) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    const radius = 3 + Math.random() * 17;
    const glow = context.createRadialGradient(x, y, 0, x, y, radius);
    glow.addColorStop(0, `rgba(120, 220, 255, ${0.3 + Math.random() * 0.7})`);
    glow.addColorStop(1, 'rgba(120, 220, 255, 0)');
    context.fillStyle = glow;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  const image = context.getImageData(0, 0, width, height);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const noise = (Math.random() * 48) | 0;
    image.data[offset] = Math.min(255, image.data[offset] + (noise >> 1));
    image.data[offset + 1] = Math.min(255, image.data[offset + 1] + noise);
    image.data[offset + 2] = Math.min(255, image.data[offset + 2] + noise);
  }
  context.putImageData(image, 0, 0);

  context.fillStyle = 'rgba(221, 229, 238, 0.9)';
  context.font = '11px ui-monospace, monospace';
  context.fillText(
    `${state.sandbox?.sandbox.tenantSlug ?? 'sandbox'} · ${new Date().toISOString()}`,
    10,
    height - 12,
  );

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, FRAME_MEDIA_TYPE));
  const bytes = new Uint8Array(await blob.arrayBuffer());

  if (crypto.subtle === undefined) {
    // Web Crypto exists only in a secure context. Over plain HTTP on anything
    // but localhost it is simply absent, and the failure would otherwise be a
    // TypeError on a property nobody would think to look at.
    $('#sandbox-run').disabled = true;
    $('#sandbox-run-note').className = 'error';
    $('#sandbox-run-note').textContent =
      'SHA-256 needs the Web Crypto API, which browsers expose only over HTTPS or on localhost. ' +
      'Open this page over HTTPS to run the lifecycle.';
    return null;
  }

  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const digest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  state.frame = { bytes, digest, width, height };

  $('#frame-name').textContent = FRAME_NAME;
  $('#frame-size').textContent =
    `${formatBytes(bytes.length)} — ${bytes.length} bytes, ${width}×${height}`;
  $('#frame-digest').textContent = digest;
  $('#sandbox-run').disabled = false;
  $('#sandbox-run-note').className = 'muted';
  $('#sandbox-run-note').textContent = '';

  return state.frame;
}

/**
 * One flipped bit, in the middle of the object rather than in its header.
 *
 * A corrupted PNG signature would be caught by anything that so much as sniffs
 * the file. The interesting claim is that a single bit deep inside the payload
 * -- which no downstream reader would ever notice, and which is exactly what a
 * flaky link produces -- is caught anyway, by comparing against a digest the
 * producer declared before the transfer began.
 */
function bytesToSend(frame) {
  if (!$('#sandbox-corrupt').checked) return frame.bytes;

  const copy = frame.bytes.slice();
  copy[Math.floor(copy.length / 2)] ^= 0x01;
  return copy;
}

// ---------------------------------------------------------------------------
// the timeline
// ---------------------------------------------------------------------------

function resetTimeline() {
  const timeline = $('#sandbox-timeline');
  timeline.hidden = false;
  timeline.innerHTML = LIFECYCLE_STEPS.map(
    ([id, title]) => `
      <li id="step-${id}" class="step pending">
        <div class="step-head">
          <span class="step-title">${escapeHtml(title)}</span>
          <code class="step-call"></code>
        </div>
        <div class="step-body"></div>
      </li>`,
  ).join('');
}

/**
 * Each step names the request it is about to make, before making it.
 *
 * A developer watching this should be able to map every row onto an operation in
 * /docs without guessing. A stepper that reported only outcomes would be a
 * progress bar.
 */
function beginStep(id, calls) {
  const step = $(`#step-${id}`);
  step.className = 'step active';
  step.querySelector('.step-call').innerHTML = [calls]
    .flat()
    .map((call) => escapeHtml(call))
    .join('<br />');
  step.querySelector('.step-body').innerHTML = '<span class="muted">in flight…</span>';
}

function finishStep(id, html) {
  const step = $(`#step-${id}`);
  step.className = 'step done';
  step.querySelector('.step-body').innerHTML = html;
}

function failStep(id, html) {
  const step = $(`#step-${id}`);
  step.className = 'step failed';
  step.querySelector('.step-body').innerHTML = html;
}

/** Everything from `id` onwards, with a reason on the first one and nothing on the rest. */
function skipFrom(id, note) {
  const from = LIFECYCLE_STEPS.findIndex(([stepId]) => stepId === id);
  LIFECYCLE_STEPS.slice(from).forEach(([stepId], index) => {
    const step = $(`#step-${stepId}`);
    step.className = 'step skipped';
    step.querySelector('.step-body').innerHTML =
      index === 0 ? note : '<span class="muted">not reached</span>';
  });
}

/**
 * The whole problem document, not one sentence out of it.
 *
 * RFC 9457's extension members are the part worth reading -- which quota, which
 * two digests, which sequence number -- and a client that renders only `detail`
 * throws away the reason the service bothered to include them.
 */
function problemHtml(error) {
  const problem = error.problem;
  if (!problem) return `<p class="error">${escapeHtml(error.message)}</p>`;

  const standard = new Set(['type', 'title', 'status', 'detail', 'instance']);
  const extras = Object.entries(problem)
    .filter(([member]) => !standard.has(member))
    .map(
      ([member, value]) =>
        `<dt>${escapeHtml(member)}</dt><dd>${escapeHtml(
          value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value),
        )}</dd>`,
    )
    .join('');

  return `
    <div class="problem">
      <div class="problem-head">
        <span class="badge REJECTED">${escapeHtml(String(problem.status ?? error.status))}</span>
        <strong>${escapeHtml(problem.title ?? 'Error')}</strong>
        <code class="muted">${escapeHtml(problem.type ?? '')}</code>
      </div>
      <p>${escapeHtml(problem.detail ?? error.message)}</p>
      ${extras === '' ? '' : `<dl class="kv">${extras}</dl>`}
    </div>`;
}

/** The refusals the sandbox itself issues, each with the one thing left to do about it. */
function sandboxGuidance(error) {
  const type = error.problem?.type ?? '';

  if (type.endsWith('/sandbox-expired')) {
    return `<p>The hour is up and this tenant is being deleted along with everything in it. The
      token is genuine and has not itself expired — the token and the tenant are separate clocks,
      which is why this is a 403 and not a 401.
      <button type="button" data-action="new-sandbox">Start another sandbox</button></p>`;
  }
  if (type.endsWith('/sandbox-quota-exceeded')) {
    return `<p>This sandbox has spent that allowance, and no amount of waiting returns it — which is
      why the refusal is a 409 rather than a 429, and carries no <code>Retry-After</code>.
      <button type="button" data-action="new-sandbox">Start another sandbox</button></p>`;
  }
  if (type.endsWith('/artifact-too-large')) {
    return `<p>The cap is enforced against the <em>declared</em> size, at registration, before any
      upload URL exists — so nothing was stored and no run was created.
      <button type="button" data-action="smaller-frame">Generate a smaller frame</button></p>`;
  }
  return '';
}

// The timeline is rebuilt on every run, so its buttons are bound once here
// rather than re-bound on each render.
$('#sandbox-timeline').addEventListener('click', async (event) => {
  const action = event.target.dataset?.action;
  if (action === undefined) return;

  if (action === 'new-sandbox') {
    rememberSandbox(null);
    $('#sandbox-start').textContent = 'Start another sandbox';
    await startSandbox();
    return;
  }
  if (action === 'smaller-frame') {
    FRAME_SIZE.width = Math.max(64, Math.floor(FRAME_SIZE.width / 2));
    FRAME_SIZE.height = Math.max(64, Math.floor(FRAME_SIZE.height / 2));
    await generateFrame(FRAME_SIZE.width, FRAME_SIZE.height);
    return;
  }
  if (action === 'run-clean') {
    $('#sandbox-corrupt').checked = false;
    $('#sandbox-corrupt').dispatchEvent(new Event('change'));
    await generateFrame(FRAME_SIZE.width, FRAME_SIZE.height);
    await runLifecycle();
  }
});

// ---------------------------------------------------------------------------
// the lifecycle
// ---------------------------------------------------------------------------

async function runLifecycle() {
  if (state.sandbox === null || state.frame === null) return;

  const token = state.sandbox.token;
  const { studyId, instrumentId } = state.sandbox.sandbox;
  const frame = state.frame;
  const corrupted = $('#sandbox-corrupt').checked;

  $('#sandbox-run').disabled = true;
  $('#sandbox-run-note').className = 'muted';
  $('#sandbox-run-note').textContent = '';
  resetTimeline();

  try {
    // 1 -- register --------------------------------------------------------
    beginStep('register', `POST /v1/studies/${studyId}/runs`);
    let registered;
    try {
      registered = await api(`/v1/studies/${studyId}/runs`, {
        method: 'POST',
        token,
        quiet: true,
        // Required, not honoured-if-present. The clients this API is written for
        // are instrument agents that retry on any timeout, and an endpoint that
        // accepts an unkeyed retry will eventually register one acquisition
        // twice.
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          instrumentId,
          acquiredAt: new Date().toISOString(),
          protocol: { objective: '20x', channels: ['DAPI'], binning: 1 },
          manifest: [
            {
              logicalName: FRAME_NAME,
              digest: frame.digest,
              sizeBytes: String(frame.bytes.length),
              mediaType: FRAME_MEDIA_TYPE,
            },
          ],
        }),
      });
    } catch (error) {
      failStep('register', problemHtml(error) + sandboxGuidance(error));
      skipFrom('begin', '<span class="muted">no run was created</span>');
      return;
    }

    const runId = registered.run.id;
    finishStep(
      'register',
      `<dl class="kv">
        <dt>run</dt><dd>${escapeHtml(runId)}</dd>
        <dt>state</dt><dd><span class="badge ${registered.run.state}">${registered.run.state}</span></dd>
        <dt>manifest digest</dt><dd class="digest">${escapeHtml(registered.run.manifestDigest)}</dd>
        <dt>audit seq</dt><dd>${escapeHtml(registered.auditSeq)}</dd>
      </dl>
      <p class="muted">The manifest is now a promise: one artifact, that name, that size, that
      SHA-256. Nothing has been uploaded, and there are no bytes yet for the promise to be checked
      against.</p>`,
    );

    // 2 -- open the upload -------------------------------------------------
    // The logical name spans several path segments on purpose: instruments write
    // directory trees, and flattening one loses information the scientist relies
    // on.
    const uploadPath = `/v1/runs/${runId}/artifacts/${FRAME_NAME}/upload`;
    beginStep('begin', `POST ${uploadPath}`);
    let session;
    try {
      session = await api(uploadPath, { method: 'POST', token, quiet: true });
    } catch (error) {
      failStep('begin', problemHtml(error) + sandboxGuidance(error));
      skipFrom('put', '<span class="muted">no upload URL was issued</span>');
      return;
    }

    if (session.alreadyPresent) {
      // Content addressing paying for itself: this tenant already holds an
      // object with that digest, so the manifest entry is bound to it and no
      // bytes move. Every frame here is freshly generated, so this is
      // effectively unreachable -- and it is the correct answer when it is not.
      finishStep(
        'begin',
        `<p>This tenant already holds these exact bytes, so the manifest entry was bound to the
        existing artifact and no transfer is needed.</p>
        <dl class="kv"><dt>artifact</dt><dd>${escapeHtml(session.artifactId)}</dd></dl>`,
      );
      skipFrom('put', '<span class="muted">deduplicated; no bytes moved</span>');
      return;
    }

    if (session.outstandingParts > session.parts.length) {
      failStep(
        'begin',
        `<p class="error">This artifact needs ${session.outstandingParts} parts and only
        ${session.parts.length} came back signed. Resuming across windows is a real client concern
        and this page does not implement it: at the sandbox's artifact cap an upload is one or two
        parts, so reaching this means the deployment's part size is configured far below its
        cap.</p>`,
      );
      skipFrom('put', '<span class="muted">not attempted</span>');
      return;
    }

    finishStep(
      'begin',
      `<dl class="kv">
        <dt>session</dt><dd>${escapeHtml(session.sessionId)}</dd>
        <dt>storage key</dt><dd class="digest">${escapeHtml(session.storageKey)}</dd>
        <dt>parts</dt><dd>${session.totalParts} × ${formatBytes(session.partSize)}</dd>
        <dt>presigned urls</dt><dd>${session.parts.length}</dd>
      </dl>
      <p class="muted">The storage key is the content address — the declared digest, not the logical
      name. What comes back is a set of presigned URLs, and the bytes will travel from this page
      straight to the object store: the API is not in the data path at all, which is why it can
      ingest a 300 GB stack without proxying one. The signature is in the query string and expires;
      resuming asks for fresh URLs rather than reusing stored ones.</p>`,
    );

    // 3 -- PUT the parts ---------------------------------------------------
    const payload = bytesToSend(frame);
    beginStep(
      'put',
      session.parts.map(
        (part) => `PUT ${safeUrl(part.url)} — part ${part.partNumber}, cross-origin, presigned`,
      ),
    );

    const uploaded = [];
    for (const part of session.parts) {
      const offset = Number(part.offset);
      const slice = payload.slice(offset, offset + Number(part.sizeBytes));

      let response;
      try {
        response = await fetch(part.url, { method: 'PUT', body: slice });
      } catch (error) {
        failStep('put', networkFailureHtml(part.url, error));
        skipFrom('parts', '<span class="muted">no entity tag to record</span>');
        return;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        failStep(
          'put',
          `<p class="error">The object store refused the PUT with ${response.status}
          ${escapeHtml(response.statusText)}.</p>
          <p class="muted">That is the object store answering, not this API: a presigned URL that
          has expired, or a signature the store will not accept.</p>
          ${body === '' ? '' : `<pre class="raw">${escapeHtml(body.slice(0, 600))}</pre>`}`,
        );
        skipFrom('parts', '<span class="muted">no entity tag to record</span>');
        return;
      }

      const etag = response.headers.get('etag');
      if (etag === null) {
        // The upload worked and its answer is unreadable, which is worse than a
        // failure: everything looks fine until completion refuses a set of parts
        // the client has no way to name.
        failStep(
          'put',
          `<p class="error">The part uploaded, but the browser cannot read the <code>ETag</code>
          response header.</p>
          <p>That is a CORS gap on the bucket rather than a fault here. A cross-origin response
          exposes no headers unless the bucket's policy names them, so this needs <code>ETag</code>
          in <code>ExposeHeaders</code>. Without the entity tag there is nothing to record and the
          upload cannot be completed.</p>`,
        );
        skipFrom('parts', '<span class="muted">no entity tag to record</span>');
        return;
      }

      uploaded.push({ partNumber: part.partNumber, etag, sizeBytes: slice.length });
    }

    finishStep(
      'put',
      `<dl class="kv">
        <dt>sent</dt><dd>${formatBytes(payload.length)} in ${uploaded.length} part(s)</dd>
        <dt>entity tags</dt><dd class="digest">${uploaded.map((part) => escapeHtml(part.etag)).join(', ')}</dd>
      </dl>
      ${
        corrupted
          ? `<p class="warn">One byte was flipped on the way out. What is now in the object store is
             not what that digest describes — and nothing has noticed, because the store stored
             precisely what it was handed and what it was handed looked fine.</p>`
          : `<p class="muted">Straight to the object store. The API has still not seen a single one
             of these bytes.</p>`
      }`,
    );

    // 4 -- record the parts ------------------------------------------------
    beginStep('parts', `POST ${uploadPath}/parts × ${uploaded.length}`);
    let recorded;
    try {
      for (const part of uploaded) {
        recorded = await api(`${uploadPath}/parts`, {
          method: 'POST',
          token,
          quiet: true,
          body: JSON.stringify({
            sessionId: session.sessionId,
            partNumber: part.partNumber,
            etag: part.etag,
            sizeBytes: String(part.sizeBytes),
          }),
        });
      }
    } catch (error) {
      failStep('parts', problemHtml(error) + sandboxGuidance(error));
      skipFrom('complete', '<span class="muted">not attempted</span>');
      return;
    }

    finishStep(
      'parts',
      `<dl class="kv"><dt>recorded</dt><dd>${recorded.completedParts} of ${recorded.totalParts}</dd></dl>
      <p class="muted">Strictly optional: completion also accepts the entity tags inline. Recording
      them as they land is what makes an interrupted transfer resumable — a client that comes back
      tomorrow is told which parts already exist and is signed fresh URLs for the rest. Since the
      service already holds them, the completion below sends no parts at all.</p>`,
    );

    // 5 -- complete, and verify --------------------------------------------
    beginStep('complete', `POST ${uploadPath}/complete`);
    let completed;
    try {
      completed = await api(`${uploadPath}/complete`, {
        method: 'POST',
        token,
        quiet: true,
        body: JSON.stringify({}),
      });
    } catch (error) {
      await reportVerificationFailure(error, runId, token);
      return;
    }

    finishStep(
      'complete',
      `<dl class="kv">
        <dt>artifact</dt><dd>${escapeHtml(completed.artifactId)}</dd>
        <dt>digest</dt><dd class="digest">${escapeHtml(completed.digest)}</dd>
        <dt>size</dt><dd>${formatBytes(completed.sizeBytes)}</dd>
        <dt>audit seq</dt><dd>${escapeHtml(String(completed.auditSeq))}</dd>
      </dl>
      <p class="muted">The service asked the store to assemble the parts, then read every stored
      byte back out, hashed it in one streaming pass, and compared the result with what was declared
      before the transfer began. That read is the dominant cost of ingest and it is paid
      deliberately: a service that never computes a digest can never report a mismatch, and a
      property no test can break is not a property.</p>`,
    );

    // 6 -- seal ------------------------------------------------------------
    beginStep('seal', `POST /v1/runs/${runId}/seal`);
    let sealed;
    try {
      sealed = await api(`/v1/runs/${runId}/seal`, {
        method: 'POST',
        token,
        quiet: true,
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({}),
      });
    } catch (error) {
      failStep('seal', problemHtml(error) + sandboxGuidance(error));
      skipFrom('processing', '<span class="muted">nothing was enqueued</span>');
      return;
    }

    finishStep(
      'seal',
      `<dl class="kv">
        <dt>state</dt><dd><span class="badge ${sealed.run.state}">${sealed.run.state}</span></dd>
        <dt>sealed at</dt><dd>${escapeHtml(sealed.run.sealedAt ?? '')}</dd>
        <dt>processing job</dt><dd>${escapeHtml(sealed.processingJobId ?? 'already queued')}</dd>
        <dt>audit seq</dt><dd>${escapeHtml(sealed.auditSeq)}</dd>
      </dl>
      <p class="muted">The seal, its audit event and the processing job were written in one
      transaction. There is no window in which a run is sealed and its work is not queued, because
      there is no second system to write to — the queue is a table in the same database.</p>`,
    );

    // 7 -- processing ------------------------------------------------------
    beginStep('processing', `GET /v1/runs/${runId} — polled`);
    let run = null;
    for (let attempt = 0; attempt < PROCESSING_POLL_ATTEMPTS; attempt += 1) {
      await sleep(PROCESSING_POLL_MS);
      try {
        run = await api(`/v1/runs/${runId}`, { token, quiet: true });
      } catch (error) {
        failStep('processing', problemHtml(error));
        skipFrom('lineage', '<span class="muted">not attempted</span>');
        return;
      }
      if (run.state === 'PROCESSED' || run.state === 'PROCESSING_FAILED') break;
    }

    if (run.state !== 'PROCESSED') {
      failStep(
        'processing',
        `<dl class="kv">
          <dt>state</dt><dd><span class="badge ${run.state}">${run.state}</span></dd>
          <dt>error</dt><dd>${escapeHtml(run.processingError ?? '—')}</dd>
        </dl>
        <p class="muted">A run whose processing failed keeps its verified artifacts: the bytes were
        ingested correctly and only the derived work is missing. A run still sitting at
        <code>SEALED</code> means no worker is running against this deployment.</p>`,
      );
      skipFrom('lineage', '<span class="muted">nothing was derived</span>');
      return;
    }

    const entry = run.manifest[0];
    finishStep(
      'processing',
      `<dl class="kv">
        <dt>state</dt><dd><span class="badge ${run.state}">${run.state}</span></dd>
        <dt>attempts</dt><dd>${run.processingAttempts}</dd>
        <dt>artifact</dt>
        <dd><span class="badge ${entry.verificationState}">${entry.verificationState}</span>
          ${escapeHtml(entry.artifactId ?? '')}</dd>
      </dl>
      <p class="muted">A separate worker process claimed the job, read the artifact back out of
      storage and ran the processors over it. One of them recognised the PNG by its magic bytes and
      read the dimensions out of it — which is why the frame above had to be a real image.</p>`,
    );

    // 8 and 9 -- provenance, and the record of all of it --------------------
    const events = await showProvenance(runId, entry, token);
    showChain(events);
    await showVerification(events, token);

    $('#sandbox-run-note').textContent = corrupted
      ? ''
      : 'Now turn on “corrupt one byte in transit” and run it again.';
  } finally {
    $('#sandbox-run').disabled = false;
    await refreshSandbox();
  }
}

/**
 * The corrupted path ends here, and the run ends with it.
 *
 * Two calls rather than one: the refusal says what was wrong with the bytes, and
 * the run says what happened to the run because of it. The second is the part
 * that matters — quarantine is not a flag on an artifact, it is a terminal state
 * for the whole acquisition.
 */
async function reportVerificationFailure(error, runId, token) {
  let run = null;
  try {
    run = await api(`/v1/runs/${runId}`, { token, quiet: true });
  } catch {
    // The refusal itself is the story. Failing to re-read the run costs only the
    // corroborating detail, and reporting that failure instead would bury it.
  }

  const problem = error.problem ?? {};
  const comparison =
    problem.declaredDigest && problem.computedDigest
      ? `<dl class="kv">
           <dt>declared</dt><dd class="digest">${escapeHtml(problem.declaredDigest)}</dd>
           <dt>stored</dt><dd class="digest mismatch">${escapeHtml(problem.computedDigest)}</dd>
         </dl>`
      : '';

  $('#step-complete').querySelector('.step-call').innerHTML +=
    `<br />${escapeHtml(`GET /v1/runs/${runId}`)}`;

  failStep(
    'complete',
    `${problemHtml(error)}
     ${comparison}
     ${
       run === null
         ? ''
         : `<dl class="kv">
              <dt>run state</dt><dd><span class="badge ${run.state}">${run.state}</span></dd>
              <dt>reason</dt><dd>${escapeHtml(run.quarantineReason ?? '')}</dd>
              <dt>sealed</dt><dd>${escapeHtml(run.sealedAt ?? 'never')}</dd>
            </dl>`
     }
     <p>One flipped bit, found by reading the stored object back and hashing it. Nobody had to go
     looking: the comparison happens on every upload, and those two hex strings are the whole of the
     argument.</p>
     <p><button type="button" data-action="run-clean">Run it again cleanly</button></p>`,
  );

  skipFrom(
    'seal',
    `<p>This run can never be sealed. <code>QUARANTINED</code> is terminal — the state machine has no
     edge from it to <code>SEALED</code> — so the refusal is not a policy a later caller could talk
     its way past. Nothing downstream will ever consume this acquisition, and the correction is not
     an edit: it is a new run that supersedes this one, so a citation that pointed at the original
     still points at exactly what it cited.</p>`,
  );

  $('#sandbox-run-note').className = 'muted';
  $('#sandbox-run-note').textContent =
    'That refusal is the feature. The bytes are in the bucket and the run is unusable, which is the ' +
    'correct outcome for data nobody can vouch for.';
}

/**
 * Provenance, from the API's own traversal.
 *
 * `GET /v1/artifacts/{id}/lineage` requires the scientist role or better, which
 * a sandbox session holds: it is admin of a tenant that contains nothing except
 * what this visitor put in it. The privilege is bounded by the tenant rather
 * than by the role (ADR-0021), which is what lets a stranger reach the end of
 * the story instead of being refused two steps short of it.
 *
 * Returns the audit page it fetched, so the last two steps do not ask twice for
 * the same page in a view whose whole job is to show which calls were made.
 */
async function showProvenance(runId, entry, token) {
  const lineagePath = `/v1/artifacts/${entry.artifactId}/lineage?direction=descendants`;
  beginStep('lineage', [`GET ${lineagePath}`, 'GET /v1/audit?limit=100']);

  let graph;
  let events;
  try {
    graph = await api(lineagePath, { token, quiet: true });
    events = (await api('/v1/audit?limit=100', { token, quiet: true })).items;
  } catch (error) {
    failStep('lineage', problemHtml(error));
    skipFrom('audit', '<span class="muted">not reached</span>');
    return [];
  }

  finishStep(
    'lineage',
    `<p class="muted">Nobody typed this. It is the rows the ingestion and processing paths wrote
    while doing their work, and it is the same graph the API serves as W3C PROV-JSON — which is what
    makes “we found a bug in metadata-extract 1.0.0, what is affected?” a query rather than an
    investigation.</p>
    <div id="sandbox-graph" class="graph"></div>`,
  );
  renderGraph(graph, $('#sandbox-graph'));

  return events;
}

/**
 * The chain, read from its genesis event.
 *
 * This is the one thing the seeded demo cannot show. The tenant did not exist an
 * hour ago, so `seq` 1 is this sandbox being provisioned and every event above it
 * was written by the visitor's own run.
 */
function showChain(events) {
  beginStep('audit', 'GET /v1/audit?limit=100');

  if (events.length === 0) {
    failStep('audit', '<p class="error">The audit chain could not be read.</p>');
    skipFrom('verify', '<span class="muted">nothing to verify</span>');
    return;
  }

  const rows = events
    .map(
      (event) => `<tr>
        <td class="mono">${escapeHtml(event.seq)}</td>
        <td><code>${escapeHtml(event.action)}</code></td>
        <td class="muted mono">${escapeHtml(event.targetType)} ${short(event.targetId)}</td>
        <td class="muted">${escapeHtml(event.occurredAt)}</td>
        <td><code title="${escapeHtml(event.hash)}">${short(event.hash, 12)}</code></td>
      </tr>`,
    )
    .join('');

  finishStep(
    'audit',
    `<table>
       <thead><tr><th>Seq</th><th>Action</th><th>Target</th><th>Occurred</th><th>Hash</th></tr></thead>
       <tbody>${rows}</tbody>
     </table>
     <p class="muted">${events.length} events, newest first, ending at <code>seq 1</code> — the
     provisioning of this tenant. Every one of them was written as a side effect of the steps above;
     none of them was written by this page. Each hash covers its predecessor's, and the hash is
     computed in the database over what was actually stored rather than in the application over what
     the application meant to store. The application role holds <code>INSERT</code> and
     <code>SELECT</code> on that table and nothing else.</p>
     <p class="muted">Reading it is not the same as trusting it, which is the next step.</p>`,
  );
}

/**
 * The question the whole exercise builds towards, asked about the visitor's own
 * chain rather than about a fixture.
 *
 * The seeded demo can verify a chain too, but its chain was already long before
 * anyone arrived. Here every link was written in the last minute, by steps the
 * visitor watched, and `eventsVerified` counting up from `seq 1` is the part
 * that cannot be staged.
 */
async function showVerification(events, token) {
  beginStep('verify', 'POST /v1/audit/verify');

  let result;
  try {
    result = await api('/v1/audit/verify', {
      method: 'POST',
      token,
      quiet: true,
      body: JSON.stringify({}),
    });
  } catch (error) {
    failStep('verify', problemHtml(error));
    return;
  }

  if (!result.ok) {
    // Reachable, and left reachable on purpose: a verifier that can only report
    // success has not been shown to verify anything.
    failStep(
      'verify',
      `<dl class="kv">
        <dt>broken at</dt><dd>seq ${escapeHtml(String(result.brokenAtSeq))}</dd>
        <dt>reason</dt><dd>${escapeHtml(result.reason ?? '')}</dd>
      </dl>
      <p class="error">The chain does not verify. On a tenant this young that means the audit table
      was written to by something other than <code>append_audit_event()</code>.</p>`,
    );
    return;
  }

  finishStep(
    'verify',
    `<dl class="kv">
      <dt>result</dt><dd><span class="badge VERIFIED">intact</span></dd>
      <dt>events verified</dt><dd>${escapeHtml(String(result.eventsVerified))}</dd>
      <dt>head hash</dt><dd class="digest">${escapeHtml(result.headHash ?? '')}</dd>
    </dl>
    <p class="muted">Every hash recomputed from <code>seq 1</code> — this tenant being created — to
    the event written seconds ago, each one over its predecessor's hash. The seeded demo can run this
    too, but its chain was sixty-odd events long before you arrived; this one you watched being
    written. Change one payload byte in the database and this call names the sequence number where
    the recomputation first disagrees, because the chain is computed in the database over what was
    actually stored rather than in the application over what it meant to store.</p>
    <p class="muted">${
      events.length
    } events, and none of them written by this page — they are side effects of the steps above.</p>`,
  );
}

/**
 * A fetch that never produced a status.
 *
 * Naming CORS first is not a guess. Every part upload is a cross-origin PUT,
 * which is never a simple request, so a bucket that has not been told about this
 * origin fails the preflight and the browser reports a bare TypeError with no
 * status, no headers and nothing in the response to read. Left generic, this is
 * the most opaque failure in the whole flow.
 */
function networkFailureHtml(url, error) {
  return `
    <p class="error">The browser could not complete the PUT to
    <code>${escapeHtml(safeOrigin(url))}</code>: ${escapeHtml(error.message)}</p>
    <p>No HTTP status came back at all, which from a browser almost always means the object store
    refused the CORS preflight. The bucket's CORS policy needs this page's origin
    (<code>${escapeHtml(location.origin)}</code>) in <code>AllowedOrigins</code>, <code>PUT</code> in
    <code>AllowedMethods</code>, and <code>ETag</code> in <code>ExposeHeaders</code> — the last
    because completion has to quote the entity tag the store returned, and a cross-origin response
    hides every header the policy does not name.</p>
    <p class="muted">The other candidates, in order: the object store is not reachable from this
    network at the address it signs URLs for, or something between here and it dropped the request.
    The upload is a direct browser-to-store transfer, so nothing this API does can route around
    it.</p>`;
}

/** Origin and path only. The query string of a presigned URL is a live write capability. */
function safeUrl(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}?X-Amz-Signature=…`;
}

function safeOrigin(url) {
  return new URL(url).origin;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

$('#sandbox-start').addEventListener('click', () => void startSandbox());

$('#sandbox-regenerate').addEventListener('click', () => {
  void generateFrame(FRAME_SIZE.width, FRAME_SIZE.height);
});

$('#sandbox-corrupt').addEventListener('change', (event) => {
  $('#sandbox-corrupt-label').classList.toggle('armed', event.target.checked);
  $('#sandbox-run').textContent = event.target.checked
    ? 'Run the lifecycle, corrupted'
    : 'Run the lifecycle';
});

$('#sandbox-run').addEventListener('click', () => void runLifecycle());

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function short(value, length = 8) {
  return value ? String(value).slice(0, length) : '—';
}

function truncate(value, length) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function formatBytes(value) {
  const bytes = Number(value ?? 0);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let index = 0;
  let size = bytes;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${index === 0 ? size : size.toFixed(1)} ${units[index]}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

if (state.token) void loadRuns(true);

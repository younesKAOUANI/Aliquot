// Read-only viewer. Plain ES modules, no framework, no build step (ADR-0018).
//
// Its job is to make two things legible during a demo: the provenance graph,
// and the audit chain with its verification result. It deliberately does not
// mutate anything -- every endpoint it calls is a GET, except POST /v1/audit/verify
// which is a read that happens to need a body.

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  token: sessionStorage.getItem('aliquot.token') ?? '',
  runsCursor: null,
  auditCursor: null,
};

$('#token').value = state.token;

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

async function api(path, options = {}) {
  $('#error').textContent = '';

  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    // Every error this service produces is RFC 9457 problem+json, so there is
    // exactly one shape to render rather than a guess per endpoint.
    let detail = `${response.status} ${response.statusText}`;
    try {
      const problem = await response.json();
      detail = problem.detail ?? problem.title ?? detail;
      if (problem.brokenAtSeq !== undefined) detail += ` (seq ${problem.brokenAtSeq})`;
    } catch {
      /* not json; the status line is all we have */
    }
    $('#error').textContent = detail;
    throw new Error(detail);
  }

  return response.status === 204 ? null : response.json();
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

$('#token').addEventListener('change', (event) => {
  state.token = event.target.value.trim();
  sessionStorage.setItem('aliquot.token', state.token);
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
  state.token = result.token;
  $('#token').value = result.token;
  sessionStorage.setItem('aliquot.token', state.token);
  // The response nests the principal under `user`; reading result.displayName
  // silently yielded undefined and fell back to the email every time.
  $('#whoami').textContent = result.user?.displayName ?? email;
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
    if (button.dataset.view === 'audit') void loadAudit(true);
  });
});

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

async function loadRuns(reset) {
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
      $$('nav button').find((b) => b.dataset.view === 'lineage').click();
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
 */
function renderGraph(graph) {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  if (nodes.length === 0) {
    $('#lineage-graph').innerHTML = '<p class="muted" style="padding:16px">No lineage found.</p>';
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
  const height =
    40 + Math.max(...[...columns.values()].map((c) => c.length)) * (NODE_H + GAP_Y);

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

  $('#lineage-graph').innerHTML = `
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

  const params = new URLSearchParams({ limit: '50' });
  if (state.auditCursor) params.set('cursor', state.auditCursor);

  const page = await api(`/v1/audit?${params}`);
  const body = $('#audit-table tbody');

  for (const event of page.items) {
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

  state.auditCursor = page.nextCursor;
  $('#audit-more').hidden = !page.nextCursor;
}

$('#reload-audit').addEventListener('click', () => void loadAudit(true));
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

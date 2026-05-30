/**
 * Migration lint.
 *
 * ADR-002 accepts a specific ongoing cost: with shared-schema multi-tenancy,
 * every new tenant-scoped table needs its row-level security policy, and needs
 * it *remembered*. The characteristic failure of that design is not a subtle
 * one -- it is somebody adding a table with a `tenant_id` column and forgetting
 * the three lines that make it isolated. That table then reads across tenants,
 * silently, and nothing else changes.
 *
 * This is the mitigation the ADR promised. It is a static check over the
 * migration files rather than a query against a live database, so it costs
 * nothing to run and cannot be skipped because Docker was unavailable. The
 * integration suite covers the same ground against a real database from the
 * other direction; this one catches it before the code is ever run.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * Tables that carry `tenant_id` and deliberately do not have a tenant policy.
 * Each needs a reason, and the reason is checked by a human at review time --
 * the point of the list is that adding to it is a conscious act.
 */
const EXEMPT = new Map<string, string>([
  [
    'job',
    'has bespoke policies: tenant_isolation for the API plus worker_claims_across_tenants, ' +
      'because claiming work necessarily precedes knowing whose work it is (see 0007)',
  ],
  [
    'audit_chain_head',
    'the application role has no privileges on it at all; it is reachable only through ' +
      'append_audit_event(), which is SECURITY DEFINER',
  ],
]);

interface Finding {
  file: string;
  message: string;
}

async function main(): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  let combined = '';
  const sources = new Map<string, string>();
  for (const file of files) {
    const sql = stripComments(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
    sources.set(file, sql);
    combined += `\n${sql}`;
  }

  const findings: Finding[] = [];

  for (const [file, sql] of sources) {
    for (const table of tablesWithTenantId(sql)) {
      if (EXEMPT.has(table)) continue;

      const helperApplied = new RegExp(
        `select\\s+aliquot\\.apply_tenant_rls\\(\\s*'${table}'\\s*\\)`,
        'i',
      ).test(combined);

      if (!helperApplied) {
        const enabled = new RegExp(
          `alter\\s+table\\s+aliquot\\.${table}\\s+enable\\s+row\\s+level\\s+security`,
          'i',
        ).test(combined);
        const forced = new RegExp(
          `alter\\s+table\\s+aliquot\\.${table}\\s+force\\s+row\\s+level\\s+security`,
          'i',
        ).test(combined);
        const policy = new RegExp(
          `create\\s+policy\\s+\\w+\\s+on\\s+aliquot\\.${table}\\b`,
          'i',
        ).test(combined);

        const missing = [
          !enabled && 'ENABLE ROW LEVEL SECURITY',
          !forced && 'FORCE ROW LEVEL SECURITY',
          !policy && 'a policy',
        ].filter((x): x is string => typeof x === 'string');

        if (missing.length > 0) {
          findings.push({
            file,
            message:
              `table aliquot.${table} has a tenant_id column but is missing ${missing.join(', ')}. ` +
              `Call select aliquot.apply_tenant_rls('${table}') in the migration that creates it, ` +
              'or add it to the EXEMPT list in this script with a reason.',
          });
        }
      }
    }

    // A view over an RLS-protected table executes with the privileges of its
    // owner unless told otherwise, which turns the view into a hole straight
    // through tenant isolation. It is a one-word omission with no other symptom.
    for (const view of viewsWithoutSecurityInvoker(sql)) {
      findings.push({
        file,
        message:
          `view aliquot.${view} is declared without WITH (security_invoker = true). ` +
          'Without it the view runs as its owner and the underlying row-level security ' +
          'policies are evaluated against the wrong role.',
      });
    }
  }

  // Migrations are forward-only. An ALTER or DROP against a table introduced in
  // the same file set is fine; what is not fine is editing an existing file,
  // and that is enforced by checksum in scripts/migrate.ts. This check catches
  // the other half: a file that is not numbered contiguously will be skipped or
  // reordered depending on the filesystem.
  const versions = files.map((f) => Number.parseInt(f.slice(0, 4), 10));
  versions.forEach((version, index) => {
    if (version !== index + 1) {
      findings.push({
        file: files[index] ?? '<unknown>',
        message: `expected version ${String(index + 1).padStart(4, '0')}, found ${String(version).padStart(4, '0')}. Migration numbering must be contiguous.`,
      });
    }
  });

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}: ${finding.message}`);
    }
    console.error(`\n${findings.length} migration lint failure(s)`);
    process.exitCode = 1;
    return;
  }

  console.log(`migration lint clean (${files.length} files, ${EXEMPT.size} documented exemptions)`);
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

function tablesWithTenantId(sql: string): string[] {
  const found: string[] = [];
  const pattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?aliquot\.(\w+)\s*\(/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const name = match[1];
    if (!name) continue;

    const body = balancedBody(sql, pattern.lastIndex - 1);
    if (body !== null && /\btenant_id\b/.test(body)) {
      found.push(name);
    }
  }
  return found;
}

function viewsWithoutSecurityInvoker(sql: string): string[] {
  const found: string[] = [];
  const pattern = /create\s+(?:or\s+replace\s+)?view\s+aliquot\.(\w+)([\s\S]*?)\bas\b/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const name = match[1];
    const modifiers = match[2] ?? '';
    if (name && !/security_invoker\s*=\s*true/i.test(modifiers)) {
      found.push(name);
    }
  }
  return found;
}

/** Returns the text between the parenthesis at `open` and its match. */
function balancedBody(sql: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return null;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service';
import type { Trx } from '../database/database.service';

/**
 * The lookups that necessarily happen before a tenant is known.
 *
 * Authentication has a bootstrapping problem that the rest of the service does
 * not: an instrument presents a credential and nothing else, so the tenant its
 * credential belongs to is the answer to the lookup, not an input to it. Row
 * level security is deny-by-default -- `current_tenant_id()` is null when
 * `app.tenant_id` is unset and `tenant_id = null` is false -- so there is no
 * `app.tenant_id` that would let one query find the instrument.
 *
 * This file is the whole of the workaround, and it is deliberately confined to
 * one small class so that "queries that run before a tenant is established"
 * remains a list of two:
 *
 *   - `aliquot.tenant` is read unscoped. That table is the isolation anchor and
 *     is the one table with no policy on it by design (see migration 0002); it
 *     holds no tenant data, only the registry of which tenants exist.
 *   - The instrument row itself is read *with* `app.tenant_id` set, once per
 *     candidate tenant. Every read of tenant data still passes through the
 *     policy, so a bug here cannot widen what a request can see -- it can only
 *     fail to find a credential.
 *
 * The scan is O(tenants) statements in a single transaction, memoised by key
 * prefix so a credential costs one statement after its first use. That is
 * acceptable for a service whose tenants are created administratively, and it is
 * not the right long-term shape: the right shape is a `SECURITY DEFINER`
 * function, `aliquot.resolve_instrument_credential(prefix)`, returning only the
 * columns authentication needs -- exactly the pattern `append_audit_event()`
 * already uses to reach past a policy for one specific, auditable purpose. That
 * needs a migration.
 */

export interface InstrumentCredential {
  tenantId: string;
  instrumentId: string;
  slug: string;
  displayName: string;
  apiKeyHash: string;
  disabledAt: Date | null;
}

@Injectable()
export class TenantRegistry {
  /**
   * Key prefix to the tenant that holds it.
   *
   * Only successful resolutions are recorded, so the map is bounded by the
   * number of instruments that have ever authenticated and cannot be grown by
   * probing random prefixes. A stale entry -- the instrument's key was rotated,
   * so the prefix no longer exists -- costs one wasted statement and then falls
   * through to the scan, which is why the entry is dropped on a miss rather than
   * trusted.
   */
  private readonly tenantByKeyPrefix = new Map<string, string>();

  constructor(private readonly database: DatabaseService) {}

  async instrumentByKeyPrefix(prefix: string): Promise<InstrumentCredential | null> {
    return this.database.withoutTenantScope('aliquot_app', async (trx) => {
      const remembered = this.tenantByKeyPrefix.get(prefix);
      if (remembered !== undefined) {
        const found = await probe(trx, remembered, prefix);
        if (found) {
          return found;
        }
        this.tenantByKeyPrefix.delete(prefix);
      }

      const tenants = await trx
        .selectFrom('aliquot.tenant')
        .select('id')
        .orderBy('created_at')
        .execute();

      for (const tenant of tenants) {
        if (tenant.id === remembered) {
          continue;
        }
        const found = await probe(trx, tenant.id, prefix);
        if (found) {
          this.tenantByKeyPrefix.set(prefix, tenant.id);
          return found;
        }
      }

      return null;
    });
  }

  /**
   * Tenant id for a slug, for the one caller that has a human-supplied tenant
   * name and no session: the development token endpoint.
   */
  async tenantIdForSlug(slug: string): Promise<string | null> {
    return this.database.withoutTenantScope('aliquot_app', async (trx) => {
      const row = await trx
        .selectFrom('aliquot.tenant')
        .select('id')
        .where('slug', '=', slug)
        .executeTakeFirst();

      return row?.id ?? null;
    });
  }
}

/**
 * One candidate tenant, one indexed lookup.
 *
 * `set_config(..., true)` is transaction-local, so the setting is discarded at
 * commit exactly as it is for a normal request. The instrument row is returned
 * by the policy only when the credential really does belong to this tenant,
 * which is what keeps the scan from being a hole in the isolation boundary.
 */
async function probe(
  trx: Trx,
  tenantId: string,
  prefix: string,
): Promise<InstrumentCredential | null> {
  await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);

  const row = await trx
    .selectFrom('aliquot.instrument')
    .select(['id', 'tenant_id', 'slug', 'display_name', 'api_key_hash', 'disabled_at'])
    .where('api_key_prefix', '=', prefix)
    .executeTakeFirst();

  if (row === undefined) {
    return null;
  }

  return {
    tenantId: row.tenant_id,
    instrumentId: row.id,
    slug: row.slug,
    displayName: row.display_name,
    apiKeyHash: row.api_key_hash,
    disabledAt: row.disabled_at,
  };
}

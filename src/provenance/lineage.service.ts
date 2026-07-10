import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { NotFoundError } from '../common/problem-details';
import { DatabaseService } from '../database/database.service';
import type { Trx } from '../database/database.service';
import type { RequestContext } from '../database/request-context';
import {
  Layers,
  buildEdges,
  buildNodes,
  buildRoots,
  collect,
  frontierOf,
  groupBy,
  push,
} from './lineage-graph';
import type {
  ArtifactRow,
  DerivationRow,
  Hydrated,
  InputRow,
  LineageGraph,
  LineageQuery,
  Origins,
  OutputRow,
  WalkRow,
} from './lineage-graph';

/**
 * Reading a lineage graph out of the database.
 *
 * The walk itself is a recursive CTE (`aliquot.artifact_ancestors` /
 * `aliquot.artifact_descendants`, migration 0006) rather than a loop of round
 * trips from here: a traversal issued one hop at a time would be a latency
 * multiplier over a query the database can plan once, and the depth cap that
 * guards against a cycle has to live with the recursion in any case.
 *
 * What the walk returns is thin -- (artifact, depth, derivation) triples -- so
 * everything after it is hydration: a fixed number of set-returning queries,
 * never one per node, handed to the pure assembly in `lineage-graph.ts`.
 */

@Injectable()
export class LineageService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Studies that could authorise reading this artifact's lineage.
   *
   * Content is deduplicated per tenant, so one artifact row can be bound into
   * runs belonging to several studies. Anchoring authorisation on the
   * originating run alone would refuse a scientist who legitimately holds the
   * same bytes in their own study, purely because someone else uploaded them
   * first; any binding study is the reading that matches what the caller can
   * already see of that artifact elsewhere in the API.
   */
  async studiesForArtifact(ctx: RequestContext, artifactId: string): Promise<string[]> {
    return this.database.withTenant(ctx, async (trx) => {
      const artifact = await trx
        .selectFrom('aliquot.artifact')
        .select('first_seen_run_id')
        .where('id', '=', artifactId)
        .executeTakeFirst();

      if (!artifact) {
        throw new NotFoundError('artifact', artifactId);
      }

      const rows = await trx
        .selectFrom('aliquot.run')
        .select('study_id')
        .distinct()
        .where((eb) =>
          eb.or([
            eb('id', '=', artifact.first_seen_run_id),
            eb(
              'id',
              'in',
              eb
                .selectFrom('aliquot.run_artifact')
                .select('run_id')
                .where('artifact_id', '=', artifactId),
            ),
          ]),
        )
        .execute();

      return rows.map((row) => row.study_id);
    });
  }

  async trace(ctx: RequestContext, artifactId: string, query: LineageQuery): Promise<LineageGraph> {
    return this.database.withTenant(ctx, async (trx) => {
      const layers = new Layers();
      let upstreamFrontier = new Set<string>();
      let downstreamFrontier = new Set<string>();

      if (query.direction !== 'descendants') {
        const rows = await this.walk(trx, 'ancestors', artifactId, query.maxDepth);
        upstreamFrontier = frontierOf(collect(rows, -1, layers), query.maxDepth);
      }
      if (query.direction !== 'ancestors') {
        const rows = await this.walk(trx, 'descendants', artifactId, query.maxDepth);
        downstreamFrontier = frontierOf(collect(rows, 1, layers), query.maxDepth);
      }

      // Both walks seed themselves from the artifact, so an empty result means
      // the artifact does not exist for this tenant -- not that it has no
      // lineage. Under row-level security those are the same observation.
      if (!layers.artifacts.has(artifactId)) {
        throw new NotFoundError('artifact', artifactId);
      }

      const hydrated = await this.hydrate(trx, layers);

      return {
        artifactId,
        direction: query.direction,
        maxDepth: query.maxDepth,
        truncated: await this.hasMoreBeyond(trx, hydrated, upstreamFrontier, downstreamFrontier),
        nodes: buildNodes(hydrated),
        edges: buildEdges(hydrated),
        roots: buildRoots(hydrated),
      };
    });
  }

  private async walk(
    trx: Trx,
    direction: 'ancestors' | 'descendants',
    artifactId: string,
    maxDepth: number,
  ): Promise<WalkRow[]> {
    const result =
      direction === 'ancestors'
        ? await sql<WalkRow>`
            select artifact_id, depth, derivation_id
              from aliquot.artifact_ancestors(${artifactId}::uuid, ${maxDepth}::integer)
          `.execute(trx)
        : await sql<WalkRow>`
            select artifact_id, depth, derivation_id
              from aliquot.artifact_descendants(${artifactId}::uuid, ${maxDepth}::integer)
          `.execute(trx);

    return result.rows;
  }

  private async hydrate(trx: Trx, layers: Layers): Promise<Hydrated> {
    const artifactIds = [...layers.artifacts.keys()];
    const derivationIds = [...layers.derivations.keys()];

    const artifacts = await this.loadArtifacts(trx, artifactIds);
    const derivations = await this.loadDerivations(trx, derivationIds);
    const producedBy = await this.loadOutputs(trx, artifactIds);
    const consumed = await this.loadInputs(trx, derivationIds);

    const rootIds = artifactIds.filter((id) => !producedBy.has(id));
    const origins = await this.loadOrigins(trx, artifacts, rootIds);
    const names = await this.loadNames(trx, artifacts, producedBy, rootIds);

    const outputsOf = new Map<string, string[]>();
    for (const [artifactId, outputs] of producedBy) {
      for (const output of outputs) {
        if (!layers.derivations.has(output.derivation_id)) continue;
        push(outputsOf, output.derivation_id, artifactId);
      }
    }

    const consumersOf = new Map<string, string[]>();
    for (const [derivationId, inputs] of consumed) {
      for (const input of inputs) {
        if (!layers.artifacts.has(input.artifact_id)) continue;
        push(consumersOf, input.artifact_id, derivationId);
      }
    }

    return {
      layers,
      artifacts,
      derivations,
      producedBy,
      consumed,
      outputsOf,
      consumersOf,
      origins,
      names,
      rootIds,
    };
  }

  /**
   * Whether the cap actually hid something.
   *
   * Reporting truncation whenever the frontier is non-empty would be the cheap
   * answer, and it lies in the common case: a graph exactly `maxDepth` deep is
   * complete. It is a claim about the *graph*, not about the walk, so a node at
   * the cap whose neighbour was already reached by a shorter path hides nothing
   * and does not count -- hence both tests exclude derivations that are in the
   * graph already. Upstream costs no query at all, because the producer map was
   * loaded for every artifact including the frontier.
   */
  private async hasMoreBeyond(
    trx: Trx,
    graph: Hydrated,
    upstream: Set<string>,
    downstream: Set<string>,
  ): Promise<boolean> {
    for (const artifactId of upstream) {
      const producers = graph.producedBy.get(artifactId) ?? [];
      if (producers.some((row) => !graph.layers.derivations.has(row.derivation_id))) return true;
    }

    const frontier = [...downstream];
    if (frontier.length === 0) return false;

    let statement = trx
      .selectFrom('aliquot.derivation_input')
      .select('artifact_id')
      .where('artifact_id', 'in', frontier)
      .limit(1);

    const reached = [...graph.layers.derivations.keys()];
    if (reached.length > 0) {
      statement = statement.where('derivation_id', 'not in', reached);
    }

    return (await statement.executeTakeFirst()) !== undefined;
  }

  private async loadArtifacts(trx: Trx, ids: string[]): Promise<Map<string, ArtifactRow>> {
    if (ids.length === 0) return new Map();

    const rows = await trx
      .selectFrom('aliquot.artifact')
      .select(['id', 'digest', 'size_bytes', 'media_type', 'created_at', 'first_seen_run_id'])
      .where('id', 'in', ids)
      .execute();

    return new Map(rows.map((row) => [row.id, row]));
  }

  private async loadDerivations(trx: Trx, ids: string[]): Promise<Map<string, DerivationRow>> {
    if (ids.length === 0) return new Map();

    const rows = await trx
      .selectFrom('aliquot.derivation')
      .select([
        'id',
        'processor_name',
        'processor_version',
        'parameters',
        'parameters_digest',
        'inputs_digest',
        'started_at',
        'completed_at',
        'source_run_id',
      ])
      .where('id', 'in', ids)
      .execute();

    return new Map(rows.map((row) => [row.id, row]));
  }

  private async loadOutputs(trx: Trx, artifactIds: string[]): Promise<Map<string, OutputRow[]>> {
    if (artifactIds.length === 0) return new Map();

    const rows = await trx
      .selectFrom('aliquot.derivation_output')
      .select(['derivation_id', 'artifact_id', 'logical_name'])
      .where('artifact_id', 'in', artifactIds)
      .execute();

    return groupBy(rows, (row) => row.artifact_id);
  }

  private async loadInputs(trx: Trx, derivationIds: string[]): Promise<Map<string, InputRow[]>> {
    if (derivationIds.length === 0) return new Map();

    const rows = await trx
      .selectFrom('aliquot.derivation_input')
      .select(['derivation_id', 'artifact_id', 'role'])
      .where('derivation_id', 'in', derivationIds)
      .execute();

    return groupBy(rows, (row) => row.derivation_id);
  }

  /**
   * Acquisition runs and their agents, for the roots.
   *
   * `first_seen_run_id` is the run that actually moved the bytes: deduplication
   * binds every later run declaring the same digest to the artifact row that
   * already existed. Those later runs answer a different and equally legitimate
   * question -- where else does this content appear -- and putting them in a
   * lineage graph would suggest each of them produced it.
   */
  private async loadOrigins(
    trx: Trx,
    artifacts: Map<string, ArtifactRow>,
    rootIds: string[],
  ): Promise<Origins> {
    const runIds = [
      ...new Set(
        rootIds.flatMap((id) => {
          const artifact = artifacts.get(id);
          return artifact ? [artifact.first_seen_run_id] : [];
        }),
      ),
    ];

    if (runIds.length === 0) {
      return { runs: new Map(), instruments: new Map(), users: new Map() };
    }

    const runRows = await trx
      .selectFrom('aliquot.run')
      .select([
        'id',
        'study_id',
        'instrument_id',
        'operator_id',
        'state',
        'acquired_at',
        'registered_at',
        'sealed_at',
      ])
      .where('id', 'in', runIds)
      .execute();

    const instrumentIds = [...new Set(runRows.map((run) => run.instrument_id))];
    const operatorIds = [...new Set(runRows.map((run) => run.operator_id))];

    const instrumentRows =
      instrumentIds.length === 0
        ? []
        : await trx
            .selectFrom('aliquot.instrument')
            .select(['id', 'slug', 'display_name', 'manufacturer', 'model', 'serial_number'])
            .where('id', 'in', instrumentIds)
            .execute();

    const userRows =
      operatorIds.length === 0
        ? []
        : await trx
            .selectFrom('aliquot.app_user')
            .select(['id', 'display_name'])
            .where('id', 'in', operatorIds)
            .execute();

    return {
      runs: new Map(runRows.map((row) => [row.id, row])),
      instruments: new Map(instrumentRows.map((row) => [row.id, row])),
      users: new Map(userRows.map((row) => [row.id, row])),
    };
  }

  /**
   * Human-facing names.
   *
   * Content is addressed by digest and has no name of its own -- the name
   * belongs to the relationship. A derived artifact therefore takes the output
   * name its producer gave it, and an acquired one takes the manifest entry from
   * the run that uploaded it.
   */
  private async loadNames(
    trx: Trx,
    artifacts: Map<string, ArtifactRow>,
    producedBy: Map<string, OutputRow[]>,
    rootIds: string[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();

    for (const [artifactId, outputs] of producedBy) {
      const first = outputs[0];
      if (first) names.set(artifactId, first.logical_name);
    }

    if (rootIds.length === 0) return names;

    const rows = await trx
      .selectFrom('aliquot.run_artifact')
      .select(['artifact_id', 'run_id', 'logical_name'])
      .where('artifact_id', 'in', rootIds)
      .execute();

    for (const row of rows) {
      if (row.artifact_id === null) continue;
      const artifact = artifacts.get(row.artifact_id);
      // The originating run's name wins; any other binding is a fallback so
      // that a node is never left anonymous.
      if (artifact && row.run_id === artifact.first_seen_run_id) {
        names.set(row.artifact_id, row.logical_name);
      } else if (!names.has(row.artifact_id)) {
        names.set(row.artifact_id, row.logical_name);
      }
    }

    return names;
  }
}

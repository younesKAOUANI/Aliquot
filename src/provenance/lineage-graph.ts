import type { RunState } from '../database/schema';

/**
 * The lineage graph: its shape, and the assembly of one from rows.
 *
 * Pure. Nothing here reaches a database, which is deliberate -- the part of
 * provenance that can be wrong is not fetching the rows, it is deciding which
 * node is a root, which relation is real, and whether the traversal stopped
 * because it ran out of graph or because it ran out of budget. That reasoning is
 * worth being able to exercise without a container.
 *
 * The vocabulary is W3C PROV (ADR-008): artifacts are entities, runs and
 * derivations are activities, users and instruments are agents. Node identifiers
 * are the `prov_id` strings the database views already mint
 * (`aliquot:artifact/<uuid>`), so the JSON graph and the PROV-JSON export name
 * the same things the same way and can be correlated without a mapping table --
 * and ids are unique across kinds for free.
 */

export type LineageDirection = 'ancestors' | 'descendants' | 'both';

/** PROV relation names. `from` is the subject of the relation, `to` its object. */
export type LineageEdgeType = 'used' | 'wasGeneratedBy' | 'wasAssociatedWith' | 'wasDerivedFrom';

export interface LineageEdge {
  from: string;
  to: string;
  type: LineageEdgeType;
  /** What the input was to the activity, for `used`. `null` on every other relation. */
  role: string | null;
}

interface LineageNodeBase {
  id: string;
  kind: 'artifact' | 'activity' | 'agent';
  label: string;
  sublabel: string;
  /**
   * Layout layer, not a hop count: negative upstream, positive downstream, the
   * queried artifact at 0. Entities occupy even layers and each activity the odd
   * layer between the entities it relates, which is the bipartite structure of a
   * PROV graph and lets a renderer place nodes in one pass. The traversal depth
   * that was capped is `maxDepth` on the graph, and it counts derivation hops.
   */
  depth: number;
}

export interface ArtifactNode extends LineageNodeBase {
  kind: 'artifact';
  artifactId: string;
  digest: string;
  /** bigint, so a string: `size_bytes` does not fit a double in general. */
  sizeBytes: string;
  mediaType: string;
  createdAt: Date;
  /** Manifest or output name where one is known. Content itself has no name. */
  logicalName: string | null;
}

export interface RunNode extends LineageNodeBase {
  kind: 'activity';
  activity: 'run';
  runId: string;
  studyId: string;
  state: RunState;
  acquiredAt: Date | null;
  registeredAt: Date;
  sealedAt: Date | null;
}

export interface DerivationNode extends LineageNodeBase {
  kind: 'activity';
  activity: 'derivation';
  derivationId: string;
  processorName: string;
  processorVersion: string;
  parameters: Record<string, unknown>;
  parametersDigest: string;
  inputsDigest: string;
  startedAt: Date;
  completedAt: Date | null;
  /** Carried as an attribute rather than drawn: the acquisition is already a node. */
  sourceRunId: string | null;
}

export interface UserAgentNode extends LineageNodeBase {
  kind: 'agent';
  agent: 'user';
  agentId: string;
  displayName: string;
}

export interface InstrumentAgentNode extends LineageNodeBase {
  kind: 'agent';
  agent: 'instrument';
  agentId: string;
  displayName: string;
  slug: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
}

export type LineageNode =
  ArtifactNode | RunNode | DerivationNode | UserAgentNode | InstrumentAgentNode;

export interface ProcessorRef {
  derivationId: string;
  name: string;
  version: string;
}

/**
 * An artifact in the graph that no derivation produced, and therefore the point
 * at which ancestry stops: bytes that came off an instrument.
 */
export interface LineageRoot {
  artifactId: string;
  digest: string;
  logicalName: string | null;
  run: {
    id: string;
    studyId: string;
    state: RunState;
    acquiredAt: Date | null;
    registeredAt: Date;
  } | null;
  instrument: { id: string; slug: string; displayName: string } | null;
  operator: { id: string; displayName: string } | null;
  /**
   * Every derivation reachable from this root within the returned graph: for a
   * single-path lineage, the processors that ran between these bytes and the
   * artifact that was asked about. Where several paths lead from the same root
   * it is their union, because enumerating paths is exponential in the number of
   * branch points and is not what "what processed this" is asking.
   */
  processors: ProcessorRef[];
}

export interface LineageGraph {
  artifactId: string;
  direction: LineageDirection;
  /** The traversal cap, in derivation hops, that produced this graph. */
  maxDepth: number;
  /**
   * The walk reached the cap and there is provably more graph beyond it. `false`
   * means the graph is complete in the requested direction, not merely that
   * nothing was noticed.
   */
  truncated: boolean;
  nodes: LineageNode[];
  edges: LineageEdge[];
  roots: LineageRoot[];
}

export interface LineageQuery {
  direction: LineageDirection;
  maxDepth: number;
}

export const DEFAULT_LINEAGE_DEPTH = 16;
/** The database functions default to 32, and there it is a cycle guard. */
export const MAX_LINEAGE_DEPTH = 32;

export function provId(
  kind: 'artifact' | 'run' | 'derivation' | 'user' | 'instrument',
  id: string,
): string {
  return `aliquot:${kind}/${id}`;
}

/**
 * Rows as they come back, in database spelling.
 *
 * Left in snake_case rather than mapped on arrival: the mapping happens exactly
 * once, in the node builders, and an intermediate camelCase copy would be a
 * second vocabulary for the same values with nothing to say for itself.
 */
export interface WalkRow {
  artifact_id: string;
  depth: number;
  derivation_id: string | null;
}

export interface ArtifactRow {
  id: string;
  digest: string;
  size_bytes: string;
  media_type: string;
  created_at: Date;
  first_seen_run_id: string;
}

export interface DerivationRow {
  id: string;
  processor_name: string;
  processor_version: string;
  parameters: Record<string, unknown>;
  parameters_digest: string;
  inputs_digest: string;
  started_at: Date;
  completed_at: Date | null;
  source_run_id: string | null;
}

export interface RunRow {
  id: string;
  study_id: string;
  instrument_id: string;
  operator_id: string;
  state: RunState;
  acquired_at: Date | null;
  registered_at: Date;
  sealed_at: Date | null;
}

export interface InstrumentRow {
  id: string;
  slug: string;
  display_name: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
}

export interface UserRow {
  id: string;
  display_name: string;
}

export interface OutputRow {
  derivation_id: string;
  artifact_id: string;
  logical_name: string;
}

export interface InputRow {
  derivation_id: string;
  artifact_id: string;
  role: string;
}

export interface Origins {
  runs: Map<string, RunRow>;
  instruments: Map<string, InstrumentRow>;
  users: Map<string, UserRow>;
}

/**
 * Everything the assembly steps need, resolved once.
 *
 * `producedBy` covers every artifact in the graph whether or not its producing
 * derivation was itself reached, because that distinction is exactly what
 * separates a root from an artifact whose producer lies beyond the requested
 * direction. Getting it wrong would attribute derived bytes to an instrument.
 */
export interface Hydrated {
  layers: Layers;
  artifacts: Map<string, ArtifactRow>;
  derivations: Map<string, DerivationRow>;
  producedBy: Map<string, OutputRow[]>;
  consumed: Map<string, InputRow[]>;
  /** Derivation to the artifacts it produced *that are in this graph*. */
  outputsOf: Map<string, string[]>;
  /** Artifact to the in-graph derivations that consumed it. */
  consumersOf: Map<string, string[]>;
  origins: Origins;
  names: Map<string, string>;
  rootIds: string[];
}

/** Layers are doubled so an activity can sit between the entities it relates. */
const LAYER_STRIDE = 2;

/** Layer assignment, keeping whichever sighting of a node is closest to the query. */
export class Layers {
  readonly artifacts = new Map<string, number>();
  readonly derivations = new Map<string, number>();

  artifact(id: string, layer: number): void {
    assign(this.artifacts, id, layer);
  }

  derivation(id: string, layer: number): void {
    assign(this.derivations, id, layer);
  }
}

function assign(layers: Map<string, number>, id: string, layer: number): void {
  const existing = layers.get(id);
  if (existing === undefined || Math.abs(layer) < Math.abs(existing)) {
    layers.set(id, layer);
  }
}

/** Fold one walk into the layer assignment, and report each artifact's shortest hop. */
export function collect(rows: WalkRow[], sign: 1 | -1, layers: Layers): Map<string, number> {
  const shortest = new Map<string, number>();

  for (const row of rows) {
    layers.artifact(row.artifact_id, sign * LAYER_STRIDE * row.depth);
    if (row.derivation_id !== null) {
      // The activity sits one layer inside the entity it led to.
      layers.derivation(row.derivation_id, sign * (LAYER_STRIDE * row.depth - 1));
    }

    const seen = shortest.get(row.artifact_id);
    if (seen === undefined || row.depth < seen) {
      shortest.set(row.artifact_id, row.depth);
    }
  }

  return shortest;
}

/**
 * The nodes the walk stopped at.
 *
 * Shortest hop rather than any sighting: the recursion explores every path, so
 * an artifact reachable both at the cap and by a shorter route was expanded
 * through the shorter one and nothing beyond it was lost.
 */
export function frontierOf(shortest: Map<string, number>, maxDepth: number): Set<string> {
  const frontier = new Set<string>();
  for (const [artifactId, depth] of shortest) {
    if (depth >= maxDepth) frontier.add(artifactId);
  }
  return frontier;
}

export function buildNodes(graph: Hydrated): LineageNode[] {
  const nodes: LineageNode[] = [];

  for (const [artifactId, depth] of graph.layers.artifacts) {
    const artifact = graph.artifacts.get(artifactId);
    if (!artifact) continue;
    const logicalName = graph.names.get(artifactId) ?? null;

    nodes.push({
      id: provId('artifact', artifactId),
      kind: 'artifact',
      label: logicalName ?? shortDigest(artifact.digest),
      sublabel: shortDigest(artifact.digest),
      depth,
      artifactId,
      digest: artifact.digest,
      sizeBytes: artifact.size_bytes,
      mediaType: artifact.media_type,
      createdAt: artifact.created_at,
      logicalName,
    });
  }

  for (const [derivationId, depth] of graph.layers.derivations) {
    const derivation = graph.derivations.get(derivationId);
    if (!derivation) continue;

    nodes.push({
      id: provId('derivation', derivationId),
      kind: 'activity',
      activity: 'derivation',
      label: derivation.processor_name,
      sublabel: derivation.processor_version,
      depth,
      derivationId,
      processorName: derivation.processor_name,
      processorVersion: derivation.processor_version,
      parameters: derivation.parameters,
      parametersDigest: derivation.parameters_digest,
      inputsDigest: derivation.inputs_digest,
      startedAt: derivation.started_at,
      completedAt: derivation.completed_at,
      sourceRunId: derivation.source_run_id,
    });
  }

  // Acquisition runs and their agents are attached to every root, in every
  // direction -- including a pure descendancy query, where the root is normally
  // the artifact that was asked about. A graph that does not say which
  // instrument the starting bytes came off is not one anybody can act on, and
  // the run is one edge away from an artifact already in hand. An artifact whose
  // producer lies outside the requested direction is not a root and gets
  // neither, which is the honest answer rather than a guess.
  const seenAgents = new Set<string>();

  for (const [runId, depth] of originLayers(graph)) {
    const run = graph.origins.runs.get(runId);
    if (!run) continue;

    nodes.push({
      id: provId('run', runId),
      kind: 'activity',
      activity: 'run',
      label: `run ${runId.slice(0, 8)}`,
      sublabel: run.state,
      depth,
      runId,
      studyId: run.study_id,
      state: run.state,
      acquiredAt: run.acquired_at,
      registeredAt: run.registered_at,
      sealedAt: run.sealed_at,
    });

    const instrument = graph.origins.instruments.get(run.instrument_id);
    if (instrument && !seenAgents.has(instrument.id)) {
      seenAgents.add(instrument.id);
      nodes.push({
        id: provId('instrument', instrument.id),
        kind: 'agent',
        agent: 'instrument',
        label: instrument.display_name,
        sublabel: instrument.slug,
        depth: depth - 1,
        agentId: instrument.id,
        displayName: instrument.display_name,
        slug: instrument.slug,
        manufacturer: instrument.manufacturer,
        model: instrument.model,
        serialNumber: instrument.serial_number,
      });
    }

    const operator = graph.origins.users.get(run.operator_id);
    if (operator && !seenAgents.has(operator.id)) {
      seenAgents.add(operator.id);
      nodes.push({
        id: provId('user', operator.id),
        kind: 'agent',
        agent: 'user',
        label: operator.display_name,
        sublabel: 'operator',
        depth: depth - 1,
        agentId: operator.id,
        displayName: operator.display_name,
      });
    }
  }

  return nodes;
}

/** A producing run sits one layer upstream of the artifact it generated. */
function originLayers(graph: Hydrated): Map<string, number> {
  const runLayers = new Map<string, number>();

  for (const artifactId of graph.rootIds) {
    const artifact = graph.artifacts.get(artifactId);
    const depth = graph.layers.artifacts.get(artifactId);
    if (!artifact || depth === undefined) continue;
    if (!graph.origins.runs.has(artifact.first_seen_run_id)) continue;

    const existing = runLayers.get(artifact.first_seen_run_id);
    if (existing === undefined || depth - 1 < existing) {
      runLayers.set(artifact.first_seen_run_id, depth - 1);
    }
  }

  return runLayers;
}

/**
 * Relations, restricted to pairs of nodes that are both in the graph.
 *
 * A derivation reached upstream may have produced other outputs, and one reached
 * downstream may have used other inputs; neither is in the direction that was
 * asked for. Drawing those edges would name endpoints the document never
 * declares as entities, which is both invalid PROV and an answer to a question
 * nobody asked.
 */
export function buildEdges(graph: Hydrated): LineageEdge[] {
  const edges: LineageEdge[] = [];

  for (const derivationId of graph.layers.derivations.keys()) {
    const inputs = (graph.consumed.get(derivationId) ?? []).filter((input) =>
      graph.layers.artifacts.has(input.artifact_id),
    );
    const outputs = graph.outputsOf.get(derivationId) ?? [];

    for (const input of inputs) {
      edges.push({
        from: provId('derivation', derivationId),
        to: provId('artifact', input.artifact_id),
        type: 'used',
        role: input.role,
      });
    }

    for (const artifactId of outputs) {
      edges.push({
        from: provId('artifact', artifactId),
        to: provId('derivation', derivationId),
        type: 'wasGeneratedBy',
        role: null,
      });

      // wasDerivedFrom is implied by used + wasGeneratedBy and is emitted
      // anyway, because it is the relation a consumer asking "what is this made
      // of" reads, and PROV models it as first-class for that reason.
      for (const input of inputs) {
        edges.push({
          from: provId('artifact', artifactId),
          to: provId('artifact', input.artifact_id),
          type: 'wasDerivedFrom',
          role: null,
        });
      }
    }
  }

  const seenRuns = new Set<string>();

  for (const artifactId of graph.rootIds) {
    const artifact = graph.artifacts.get(artifactId);
    const run = artifact ? graph.origins.runs.get(artifact.first_seen_run_id) : undefined;
    if (!run) continue;

    edges.push({
      from: provId('artifact', artifactId),
      to: provId('run', run.id),
      type: 'wasGeneratedBy',
      role: null,
    });

    if (seenRuns.has(run.id)) continue;
    seenRuns.add(run.id);

    if (graph.origins.instruments.has(run.instrument_id)) {
      edges.push({
        from: provId('run', run.id),
        to: provId('instrument', run.instrument_id),
        type: 'wasAssociatedWith',
        role: null,
      });
    }
    if (graph.origins.users.has(run.operator_id)) {
      edges.push({
        from: provId('run', run.id),
        to: provId('user', run.operator_id),
        type: 'wasAssociatedWith',
        role: null,
      });
    }
  }

  return edges;
}

export function buildRoots(graph: Hydrated): LineageRoot[] {
  const roots: LineageRoot[] = [];

  for (const artifactId of graph.rootIds) {
    const artifact = graph.artifacts.get(artifactId);
    if (!artifact) continue;

    const run = graph.origins.runs.get(artifact.first_seen_run_id);
    const instrument = run ? graph.origins.instruments.get(run.instrument_id) : undefined;
    const operator = run ? graph.origins.users.get(run.operator_id) : undefined;

    roots.push({
      artifactId,
      digest: artifact.digest,
      logicalName: graph.names.get(artifactId) ?? null,
      run: run
        ? {
            id: run.id,
            studyId: run.study_id,
            state: run.state,
            acquiredAt: run.acquired_at,
            registeredAt: run.registered_at,
          }
        : null,
      instrument: instrument
        ? { id: instrument.id, slug: instrument.slug, displayName: instrument.display_name }
        : null,
      operator: operator ? { id: operator.id, displayName: operator.display_name } : null,
      processors: processorsFrom(artifactId, graph),
    });
  }

  return roots;
}

/**
 * Forward reachability from a root through the derivations in the graph.
 *
 * Breadth-first over the adjacency already built during hydration, so it costs
 * no further queries, and the graph is bounded by the depth cap so the walk is
 * bounded with it.
 */
function processorsFrom(rootId: string, graph: Hydrated): ProcessorRef[] {
  const seenArtifacts = new Set<string>([rootId]);
  const seenDerivations = new Set<string>();
  const queue = [rootId];

  for (let head = 0; head < queue.length; head += 1) {
    const artifactId = queue[head];
    if (artifactId === undefined) continue;

    for (const derivationId of graph.consumersOf.get(artifactId) ?? []) {
      if (seenDerivations.has(derivationId)) continue;
      seenDerivations.add(derivationId);

      for (const produced of graph.outputsOf.get(derivationId) ?? []) {
        if (seenArtifacts.has(produced)) continue;
        seenArtifacts.add(produced);
        queue.push(produced);
      }
    }
  }

  return [...seenDerivations].flatMap((derivationId) => {
    const derivation = graph.derivations.get(derivationId);
    return derivation
      ? [{ derivationId, name: derivation.processor_name, version: derivation.processor_version }]
      : [];
  });
}

export function push<T>(index: Map<string, T[]>, key: string, value: T): void {
  const existing = index.get(key);
  if (existing) existing.push(value);
  else index.set(key, [value]);
}

export function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) push(grouped, key(row), row);
  return grouped;
}

function shortDigest(digest: string): string {
  return `sha256:${digest.slice(0, 12)}`;
}

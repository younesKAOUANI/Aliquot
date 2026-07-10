import { canonicalize } from '../common/canonical-json';
import type { LineageEdge, LineageGraph, LineageNode } from './lineage-graph';

/**
 * W3C PROV-JSON serialisation of a lineage graph.
 *
 * The bespoke alternative is tempting and cheaper: this service already returns
 * a perfectly good `{ nodes, edges }` document, and PROV costs a vocabulary, a
 * prefix block, blank-node identifiers for relations, and the discipline of
 * expressing everything interesting as an attribute rather than a field.
 *
 * It is worth paying because provenance that only this service understands is
 * provenance that dies with this service. The reason to record where data came
 * from is that somebody will ask years later, usually in a context this codebase
 * is not part of -- a journal asking how a figure was produced, a regulator
 * reconstructing an analysis, a lab merging two archives. PROV is a 2013 W3C
 * Recommendation with existing tooling (ProvToolbox, prov-python, provenance
 * store implementations) that can read, merge, query and visualise a document
 * like this one without anybody writing an adapter first. Exporting into that
 * vocabulary means the answer outlives the system that recorded it.
 *
 * What is deliberately *not* done: the graph is not stored in this shape. PROV
 * is an interchange format, and materialising it would create a second copy of
 * the truth that can disagree with the tables. Migration 0006 makes the same
 * choice with `prov_entity` / `prov_activity` / `prov_agent`, and the identifier
 * conventions here are exactly the ones those views mint.
 */

/** A PROV-JSON attribute value: a plain string, or a typed literal. */
export type ProvValue = string | { $: string; type: string };

export type ProvAttributes = Record<string, ProvValue>;

export interface ProvDocument {
  prefix: Record<string, string>;
  entity: Record<string, ProvAttributes>;
  activity: Record<string, ProvAttributes>;
  agent: Record<string, ProvAttributes>;
  used: Record<string, ProvAttributes>;
  wasGeneratedBy: Record<string, ProvAttributes>;
  wasAssociatedWith: Record<string, ProvAttributes>;
  wasDerivedFrom: Record<string, ProvAttributes>;
}

const PREFIX = {
  prov: 'http://www.w3.org/ns/prov#',
  aliquot: 'https://aliquot.dev/prov#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
};

export function toProvJson(graph: LineageGraph): ProvDocument {
  const document: ProvDocument = {
    prefix: { ...PREFIX },
    entity: {},
    activity: {},
    agent: {},
    used: {},
    wasGeneratedBy: {},
    wasAssociatedWith: {},
    wasDerivedFrom: {},
  };

  for (const node of graph.nodes) {
    describe(document, node);
  }

  // Relations are records in their own right and need identifiers. They have no
  // natural one here -- the same activity can use the same entity twice in
  // different roles -- so they get blank node identifiers, which is what the
  // PROV-JSON representation prescribes for exactly this case.
  const counters = new Map<LineageEdge['type'], number>();

  for (const edge of graph.edges) {
    const ordinal = (counters.get(edge.type) ?? 0) + 1;
    counters.set(edge.type, ordinal);
    relate(document, edge, `_:${edge.type}${ordinal}`);
  }

  return document;
}

function describe(document: ProvDocument, node: LineageNode): void {
  switch (node.kind) {
    case 'artifact':
      document.entity[node.id] = {
        'prov:type': 'aliquot:Artifact',
        'prov:label': node.label,
        'prov:generatedAtTime': dateTime(node.createdAt),
        'aliquot:digest': node.digest,
        // A bigint that has already been kept out of a double all the way from
        // the driver; typing it as xsd:long says so rather than leaving a
        // consumer to guess whether the string is a number.
        'aliquot:sizeBytes': { $: node.sizeBytes, type: 'xsd:long' },
        'aliquot:mediaType': node.mediaType,
      };
      return;

    case 'activity':
      document.activity[node.id] =
        node.activity === 'run'
          ? {
              'prov:type': 'aliquot:Acquisition',
              'prov:label': node.label,
              // Registration and sealing, matching `aliquot.prov_activity`.
              // Not `acquired_at`: that is an instrument workstation's clock,
              // which is descriptive and frequently wrong.
              'prov:startTime': dateTime(node.registeredAt),
              ...(node.sealedAt ? { 'prov:endTime': dateTime(node.sealedAt) } : {}),
              'aliquot:runState': node.state,
              'aliquot:studyId': node.studyId,
              ...(node.acquiredAt ? { 'aliquot:acquiredAt': dateTime(node.acquiredAt) } : {}),
            }
          : {
              'prov:type': 'aliquot:Computation',
              'prov:label': node.label,
              'prov:startTime': dateTime(node.startedAt),
              ...(node.completedAt ? { 'prov:endTime': dateTime(node.completedAt) } : {}),
              'aliquot:processorName': node.processorName,
              'aliquot:processorVersion': node.processorVersion,
              // PROV attribute values are literals, so the parameters travel as
              // their canonical JSON text. That is not a workaround: it is the
              // exact byte sequence `aliquot:parametersDigest` was taken over,
              // so a reader can verify the digest from this document alone.
              'aliquot:parameters': { $: canonicalize(node.parameters), type: 'xsd:string' },
              'aliquot:parametersDigest': node.parametersDigest,
              'aliquot:inputsDigest': node.inputsDigest,
              ...(node.sourceRunId ? { 'aliquot:sourceRunId': node.sourceRunId } : {}),
            };
      return;

    case 'agent':
      document.agent[node.id] =
        node.agent === 'instrument'
          ? {
              // The vocabulary's own term for a non-human actor. An instrument
              // is not a prov:Person and modelling it as one would erase the
              // distinction that makes "who did this" answerable.
              'prov:type': 'prov:SoftwareAgent',
              'prov:label': node.displayName,
              'aliquot:slug': node.slug,
              ...(node.manufacturer ? { 'aliquot:manufacturer': node.manufacturer } : {}),
              ...(node.model ? { 'aliquot:model': node.model } : {}),
              ...(node.serialNumber ? { 'aliquot:serialNumber': node.serialNumber } : {}),
            }
          : {
              'prov:type': 'prov:Person',
              'prov:label': node.displayName,
            };
      return;
  }
}

function relate(document: ProvDocument, edge: LineageEdge, id: string): void {
  switch (edge.type) {
    case 'used':
      document.used[id] = {
        'prov:activity': edge.from,
        'prov:entity': edge.to,
        ...(edge.role ? { 'prov:role': { $: edge.role, type: 'xsd:string' } } : {}),
      };
      return;

    case 'wasGeneratedBy':
      document.wasGeneratedBy[id] = {
        'prov:entity': edge.from,
        'prov:activity': edge.to,
      };
      return;

    case 'wasAssociatedWith':
      document.wasAssociatedWith[id] = {
        'prov:activity': edge.from,
        'prov:agent': edge.to,
      };
      return;

    case 'wasDerivedFrom':
      document.wasDerivedFrom[id] = {
        'prov:generatedEntity': edge.from,
        'prov:usedEntity': edge.to,
      };
      return;
  }
}

function dateTime(value: Date): ProvValue {
  return { $: value.toISOString(), type: 'xsd:dateTime' };
}

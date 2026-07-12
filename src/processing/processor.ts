import type { RequestContext } from '../database/request-context';

/**
 * What a processor is given and what it may return.
 *
 * The shape is deliberately narrow. A processor sees verified artifacts and
 * returns bytes; it does not see the database, the object store, the job, or the
 * audit log. Everything that decides *whether* the result is recorded --
 * transactions, content addressing, derivation identity -- belongs to the caller
 * and stays in one place, so adding a processor cannot weaken any of it.
 *
 * The one obligation a processor carries is determinism: identical inputs must
 * produce identical output bytes. Artifacts are content-addressed, and a
 * derivation is identified by (inputs, processor, version, parameters). A
 * processor whose output varies between runs writes a new artifact every time
 * for work the derivation constraint has already recorded as done, and the
 * idempotency the whole retry story rests on quietly stops holding.
 */

export interface ProcessorInputArtifact {
  artifactId: string;
  logicalName: string;
  digest: string;
  /** bigint because `size_bytes` is a bigint column and a large stack overflows a double. */
  sizeBytes: bigint;
  mediaType: string;
  /**
   * Fetch the bytes. Lazy and memoised by the caller, so a processor that only
   * needs metadata costs no object-store traffic and two processors reading the
   * same artifact cost one read.
   */
  read(): Promise<Uint8Array>;
}

export interface ProcessorInput {
  ctx: RequestContext;
  runId: string;
  artifacts: ProcessorInputArtifact[];
}

export interface ProcessorOutputArtifact {
  /** Name within the derivation, not within the run: a sealed run's manifest cannot grow. */
  logicalName: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface ProcessorOutput {
  outputs: ProcessorOutputArtifact[];
  /**
   * Configuration this run of the processor used. Digested into the derivation's
   * identity, so anything that changes the output belongs here and nothing that
   * does not, belongs here.
   */
  parameters: Record<string, unknown>;
}

export abstract class Processor {
  /** Matches `^[a-z0-9][a-z0-9._-]{0,63}$`; the derivation table has the same CHECK. */
  abstract readonly name: string;
  /** Semver of the code. This is what makes "which outputs came from the buggy version" a query. */
  abstract readonly version: string;

  abstract run(input: ProcessorInput): Promise<ProcessorOutput>;
}

/** Injection token for the ordered list of processors the worker runs. */
export const PROCESSORS = 'ALIQUOT_PROCESSORS';

import { Injectable } from '@nestjs/common';

import { canonicalize } from '../../common/canonical-json';
import { Processor } from '../processor';
import type { ProcessorInput, ProcessorOutput } from '../processor';

/**
 * Emits a manifest of the run's verified artifacts: logical name, digest, size
 * and media type, sorted.
 *
 * It does not re-read the bytes. Every digest here was computed over the stored
 * object at upload and the artifact row exists because it matched; hashing all
 * of it a second time would cost a full read of the run to re-derive a value the
 * ingestion path already established. This is a manifest of what the run
 * contains, not a second verification of it.
 *
 * The output is byte-deterministic, which is a requirement rather than a
 * nicety. The artifact is stored under a key derived from the digest of these
 * bytes, and the derivation that produced it is identified by its inputs. A
 * manifest that embedded a timestamp, a run id, or an unordered map would hash
 * differently on every attempt: the retry after a crash would write a second
 * artifact for work the derivation constraint says was already done, and
 * "identical work cannot create a second record" would stop being true. So the
 * content is a pure function of the inputs -- canonicalised with JCS, sorted by
 * logical name, with sizes rendered as decimal strings because JSON numbers
 * cannot carry a 64-bit size.
 */

const MANIFEST_VERSION = 1;

interface ManifestEntry {
  logicalName: string;
  digest: string;
  sizeBytes: string;
  mediaType: string;
}

@Injectable()
export class ChecksumManifestProcessor extends Processor {
  readonly name = 'checksum-manifest';
  readonly version = '1.0.0';

  run(input: ProcessorInput): Promise<ProcessorOutput> {
    const entries: ManifestEntry[] = input.artifacts
      .map((artifact) => ({
        logicalName: artifact.logicalName,
        digest: artifact.digest,
        sizeBytes: artifact.sizeBytes.toString(),
        mediaType: artifact.mediaType,
      }))
      // Logical names are unique within a run, so this is a total order and the
      // sort needs no tie-breaker. Default string comparison, deliberately: a
      // locale-aware collation is not stable across environments.
      .sort((left, right) => (left.logicalName < right.logicalName ? -1 : 1));

    const totalSizeBytes = input.artifacts.reduce(
      (total, artifact) => total + artifact.sizeBytes,
      0n,
    );

    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      artifactCount: entries.length,
      totalSizeBytes: totalSizeBytes.toString(),
      artifacts: entries,
    };

    return Promise.resolve({
      outputs: [
        {
          logicalName: 'manifest.json',
          mediaType: 'application/json',
          bytes: Buffer.from(canonicalize(manifest), 'utf8'),
        },
      ],
      // No configuration: the output is a function of the inputs alone, so the
      // derivation's identity is (inputs, name, version) and nothing else.
      parameters: {},
    });
  }
}

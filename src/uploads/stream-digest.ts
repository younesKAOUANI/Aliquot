import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

/**
 * SHA-256 and byte count over a stream, in one pass.
 *
 * The size is counted here rather than trusted from `Content-Length` because it
 * is free once the bytes are already flowing through, and because it is an
 * independent measurement: a truncated response body that still advertises the
 * full length is exactly the failure a re-read is supposed to catch, and taking
 * the size from the header would let it through.
 *
 * Nothing is buffered. The whole point of reading the object back is to verify
 * artifacts too large to hold in memory.
 */

export interface StreamDigest {
  digest: string;
  sizeBytes: bigint;
}

export async function sha256OfStream(source: Readable): Promise<StreamDigest> {
  return new Promise<StreamDigest>((resolve, reject) => {
    const hash = createHash('sha256');
    let sizeBytes = 0n;

    source.on('data', (chunk: string | Buffer) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      sizeBytes += BigInt(bytes.byteLength);
      hash.update(bytes);
    });

    source.on('end', () => {
      resolve({ digest: hash.digest('hex'), sizeBytes });
    });

    source.on('error', (error: Error) => {
      // An HTTP response body that is not drained keeps its socket checked out
      // of the agent's pool until an idle timeout fires. At one abandoned
      // stream per failed verification that is a slow leak of the connection
      // pool the next upload needs.
      source.destroy();
      reject(error);
    });
  });
}

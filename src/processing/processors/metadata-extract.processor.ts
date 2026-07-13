import { Injectable } from '@nestjs/common';

import { canonicalize } from '../../common/canonical-json';
import { Processor } from '../processor';
import type { ProcessorInput, ProcessorInputArtifact, ProcessorOutput } from '../processor';

/**
 * Reads structural metadata out of the formats it recognises by magic bytes --
 * TIFF, PNG, and delimited text -- and emits a JSON summary.
 *
 * This is a demonstration that the pipeline carries real work end to end, not an
 * attempt at scientific analysis. It reads image dimensions and line counts. It
 * does not decode pixels, interpret channels, or know what any of it means, and
 * nothing downstream should be built as though it did. A `sleep()` would have
 * exercised the dispatch machinery equally well and been far less convincing
 * about it; anything larger would be pretending this service does science, which
 * it does not.
 *
 * It never fails a job over its input. An artifact it cannot parse is recorded
 * as `unknown` with its size, because a run containing one file this code has
 * never seen is a completely normal run, and failing would retry it five times
 * and dead-letter it for no reason.
 *
 * Like every processor here, the output is byte-deterministic for the same
 * inputs: sorted, canonicalised, no timestamps. Content addressing and
 * derivation identity both depend on that.
 */

/**
 * Above this size an artifact is recorded without being inspected.
 *
 * `read()` materialises the whole object in memory, so an uncapped sniff of a
 * 200 GB image stack is an OOM rather than a metadata record. A production
 * version would range-read the first few kilobytes -- the object store supports
 * it and the abstraction here does not, which is the honest reason for the cap.
 */
const INSPECTION_LIMIT_BYTES = 16 * 1024 * 1024;

/** Enough lines to tell a table from prose that happens to contain a comma. */
const TEXT_SAMPLE_LINES = 64;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DELIMITERS = [',', '\t', ';', '|'];

const TIFF_TAG_IMAGE_WIDTH = 0x0100;
const TIFF_TAG_IMAGE_LENGTH = 0x0101;
const TIFF_TYPE_SHORT = 3;
const TIFF_TYPE_LONG = 4;

type Metadata =
  | { type: 'tiff'; byteOrder: 'little' | 'big'; width: number; height: number }
  | { type: 'png'; width: number; height: number; bitDepth: number; colorType: number }
  | { type: 'text'; lineCount: number; delimiter: string | null; columnCount: number | null }
  | { type: 'unknown'; inspected: boolean };

interface SummaryEntry {
  logicalName: string;
  digest: string;
  sizeBytes: string;
  mediaType: string;
  metadata: Metadata;
}

@Injectable()
export class MetadataExtractProcessor extends Processor {
  readonly name = 'metadata-extract';
  readonly version = '1.0.0';

  async run(input: ProcessorInput): Promise<ProcessorOutput> {
    const entries: SummaryEntry[] = [];

    // Sequential rather than concurrent: each artifact is read whole into
    // memory, and the point of the size cap is defeated by holding four of them
    // at once.
    for (const artifact of input.artifacts) {
      entries.push({
        logicalName: artifact.logicalName,
        digest: artifact.digest,
        sizeBytes: artifact.sizeBytes.toString(),
        mediaType: artifact.mediaType,
        metadata: await describe(artifact),
      });
    }

    entries.sort((left, right) => (left.logicalName < right.logicalName ? -1 : 1));

    const summary = {
      summaryVersion: 1,
      artifactCount: entries.length,
      recognisedCount: entries.filter((entry) => entry.metadata.type !== 'unknown').length,
      artifacts: entries,
    };

    return {
      outputs: [
        {
          logicalName: 'metadata.json',
          mediaType: 'application/json',
          bytes: Buffer.from(canonicalize(summary), 'utf8'),
        },
      ],
      // The limit changes what this processor emits for a large artifact, so it
      // is part of the derivation's identity. Raising it must produce a new
      // derivation rather than silently contradict an old one.
      parameters: { inspectionLimitBytes: INSPECTION_LIMIT_BYTES },
    };
  }
}

async function describe(artifact: ProcessorInputArtifact): Promise<Metadata> {
  if (artifact.sizeBytes > BigInt(INSPECTION_LIMIT_BYTES)) {
    return { type: 'unknown', inspected: false };
  }

  const bytes = await artifact.read();

  try {
    return (
      sniffTiff(bytes) ??
      sniffPng(bytes) ??
      sniffText(bytes) ?? { type: 'unknown', inspected: true }
    );
  } catch {
    // Deliberately swallowed, and only around the parsers: a truncated or
    // malformed header is data, not a system failure, and the artifact is still
    // recorded with its digest and size. The read above is outside the catch on
    // purpose -- an object store that cannot serve a verified artifact is a real
    // failure and has to reach the job.
    return { type: 'unknown', inspected: true };
  }
}

/**
 * TIFF: byte-order mark, magic 42, then the offset of the first IFD.
 *
 * Only the first directory is read, and only for dimensions. Multi-page stacks,
 * BigTIFF (magic 43) and the vendor tags that carry the acquisition settings are
 * all out of scope -- see the note at the top of the file about what this is.
 */
function sniffTiff(bytes: Uint8Array): Metadata | null {
  if (bytes.length < 8) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = view.getUint16(0, false);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return null;
  if (view.getUint16(2, little) !== 42) return null;

  const ifdOffset = view.getUint32(4, little);
  if (ifdOffset + 2 > bytes.length) return null;

  const entryCount = view.getUint16(ifdOffset, little);
  let width: number | null = null;
  let height: number | null = null;

  for (let index = 0; index < entryCount; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > bytes.length) break;

    const tag = view.getUint16(entry, little);
    if (tag !== TIFF_TAG_IMAGE_WIDTH && tag !== TIFF_TAG_IMAGE_LENGTH) continue;

    // A SHORT value sits in the first two bytes of the value field, a LONG
    // fills it. Any other type for a dimension tag is malformed; treat it as
    // absent rather than guessing at it.
    const fieldType = view.getUint16(entry + 2, little);
    let value: number | null = null;
    if (fieldType === TIFF_TYPE_SHORT) value = view.getUint16(entry + 8, little);
    else if (fieldType === TIFF_TYPE_LONG) value = view.getUint32(entry + 8, little);
    if (value === null) continue;

    if (tag === TIFF_TAG_IMAGE_WIDTH) width = value;
    else height = value;
  }

  if (width === null || height === null) return null;
  return { type: 'tiff', byteOrder: little ? 'little' : 'big', width, height };
}

/** PNG: fixed signature followed by an IHDR chunk at a fixed offset. */
function sniffPng(bytes: Uint8Array): Metadata | null {
  if (bytes.length < 26) return null;

  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;

  return {
    type: 'png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer.readUInt8(24),
    colorType: buffer.readUInt8(25),
  };
}

/**
 * Plain text, and delimited text as a special case of it.
 *
 * Field counting splits on the delimiter without honouring quoting, so a quoted
 * comma inflates the column count. That is a known limitation and not worth a
 * CSV parser here: the number is a structural hint, and it is reported as null
 * whenever the sampled lines disagree, which is what a quoted file usually does.
 */
function sniffText(bytes: Uint8Array): Metadata | null {
  if (bytes.length === 0) return null;

  let text: string;
  try {
    // fatal: an invalid sequence throws, which for most binary formats happens
    // within the first few bytes.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  if (hasControlBytes(text)) return null;

  const lines = text.split('\n');
  // A trailing newline terminates the last line rather than starting a new one.
  const lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  const sample = lines.slice(0, TEXT_SAMPLE_LINES).filter((line) => line.length > 0);

  return { type: 'text', lineCount, ...detectDelimiter(sample) };
}

/**
 * C0 control characters other than tab, newline and carriage return.
 *
 * They are valid UTF-8 and do not occur in text, so they are what catches a
 * binary format that happened to decode cleanly. Written as a scan rather than a
 * regular expression because a control character inside a character class is
 * unreadable in source and easy to corrupt in an editor.
 */
function hasControlBytes(text: string): boolean {
  const TAB = 9;
  const LINE_FEED = 10;
  const CARRIAGE_RETURN = 13;
  const FIRST_PRINTABLE = 32;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= FIRST_PRINTABLE) continue;
    if (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN) continue;
    return true;
  }
  return false;
}

function detectDelimiter(sample: string[]): {
  delimiter: string | null;
  columnCount: number | null;
} {
  const first = sample[0];
  if (first === undefined) return { delimiter: null, columnCount: null };

  for (const delimiter of DELIMITERS) {
    const columns = first.split(delimiter).length;
    if (columns < 2) continue;
    // Every sampled line has to agree. One line that happens to contain a comma
    // is prose, not a table.
    if (sample.every((line) => line.split(delimiter).length === columns)) {
      return { delimiter, columnCount: columns };
    }
  }

  return { delimiter: null, columnCount: null };
}

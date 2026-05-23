import { Injectable, LoggerService } from '@nestjs/common';
import pino, { type Logger as PinoLogger } from 'pino';

/**
 * Structured logging with a correlation identifier that survives the queue.
 *
 * The identifier is minted at the edge, stored on the job row at enqueue, and
 * restored by the worker when it claims that job. Without that hop, the two
 * halves of "why did this run never finish processing" live in unrelated log
 * streams -- which is precisely the question the operator is asking at 6pm on a
 * Friday.
 *
 * Redaction is allow-list-shaped rather than deny-list-shaped for the fields
 * that matter: an instrument API key must never reach a log sink, and a deny
 * list only stops the spellings somebody thought of.
 */

const REDACTED = '[redacted]';
const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'apikeyhash',
  'authorization',
  'password',
  'secret',
  'secretaccesskey',
  'token',
  'jwtsecret',
  // Presigned URLs carry their signature in the query string; logging one is
  // logging a live write capability against the object store.
  'uploadurl',
  'downloadurl',
  'presignedurl',
]);

export type LogFields = Record<string, unknown>;

@Injectable()
export class Logger implements LoggerService {
  private readonly pino: PinoLogger;

  constructor(options: { level?: string; pretty?: boolean; base?: LogFields } = {}) {
    this.pino = pino({
      level: options.level ?? 'info',
      base: options.base ?? {},
      // Milliseconds since epoch rather than pino's default, so log time and
      // audit `occurred_at` can be compared without a format conversion.
      timestamp: () => `,"time":${Date.now()}`,
      formatters: {
        level: (label) => ({ level: label }),
      },
      ...(options.pretty
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    });
  }

  child(fields: LogFields): Logger {
    const child = Object.create(Logger.prototype) as Logger;
    Object.defineProperty(child, 'pino', { value: this.pino.child(redact(fields) ?? {}) });
    return child;
  }

  trace(message: string, fields?: LogFields): void {
    this.pino.trace(redact(fields), message);
  }

  debug(message: string, fields?: LogFields): void {
    this.pino.debug(redact(fields), message);
  }

  log(message: string, fields?: LogFields): void {
    this.pino.info(redact(fields), message);
  }

  info(message: string, fields?: LogFields): void {
    this.pino.info(redact(fields), message);
  }

  warn(message: string, fields?: LogFields): void {
    this.pino.warn(redact(fields), message);
  }

  error(message: string, fields?: LogFields): void {
    this.pino.error(redact(fields), message);
  }

  fatal(message: string, fields?: LogFields): void {
    this.pino.fatal(redact(fields), message);
  }

  /** Nest's LoggerService calls this for unhandled exceptions. */
  verbose(message: string, fields?: LogFields): void {
    this.pino.debug(redact(fields), message);
  }
}

function redact(fields: LogFields | undefined, depth = 0): LogFields | undefined {
  if (!fields || depth > 6) return fields;

  const output: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ''))) {
      output[key] = REDACTED;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = redact(value as LogFields, depth + 1);
    } else {
      output[key] = value;
    }
  }
  return output;
}

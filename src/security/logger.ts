import pino from 'pino';
import type { Logger } from 'pino';
import { redactSecrets } from './index.js';
/** Structured fields are redacted before pino serializes them. Messages must be fixed text. */
export function createLogger(level = 'info'): Logger {
  return pino({ level, formatters: { log: object => redactSecrets(object) as Record<string, unknown> }, serializers: { err: error => redactSecrets(error) } });
}

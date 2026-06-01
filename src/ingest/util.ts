import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import type { Writable } from 'node:stream';

// Escape one value for PostgreSQL COPY ... FROM STDIN (text format).
// Empty/undefined/null all map to NULL (\N).
export function esc(v: unknown): string {
  if (v === null || v === undefined) return '\\N';
  if (v instanceof Date) return v.toISOString();
  const s = typeof v === 'string' ? v : String(v);
  if (s === '') return '\\N';
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// Build one COPY text-format line (tab-delimited, newline-terminated).
export function row(...vals: unknown[]): string {
  return vals.map(esc).join('\t') + '\n';
}

// Backpressure-aware write to a COPY stream.
export async function write(stream: Writable, line: string): Promise<void> {
  if (!stream.write(line)) await once(stream, 'drain');
}

export async function end(stream: Writable): Promise<void> {
  stream.end();
  await finished(stream);
}

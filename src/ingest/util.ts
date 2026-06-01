import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import type { Writable } from 'node:stream';

// NUL byte (0x00) — valid UTF-8 but rejected by Postgres text columns.
// Built via fromCharCode to keep this source file free of control bytes.
const NUL = String.fromCharCode(0);

// Escape one value for PostgreSQL COPY ... FROM STDIN (text format).
// Empty/undefined/null all map to NULL (\N).
export function esc(v: unknown): string {
  if (v === null || v === undefined) return '\\N';
  if (v instanceof Date) return v.toISOString();
  // Strip NUL bytes (Open Food Facts free-text fields occasionally contain them).
  const s = (typeof v === 'string' ? v : String(v)).split(NUL).join('');
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

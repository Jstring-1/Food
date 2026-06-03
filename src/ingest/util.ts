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

// JSON-encode a string array for a JSONB COPY field. Strips the escaped-NUL
// sequence: it is valid JSON but Postgres JSONB rejects it on insert.
export function jsonArray(arr: string[]): string {
  return JSON.stringify(arr).replace(/\\u0000/g, '');
}

// Parse a list-of-strings cell. RecipeNLG stores valid JSON arrays; Food.com
// stores Python/R list reprs (single quotes, apostrophes inside, c("a","b")).
// Try JSON first, then fall back to a quote-aware tokenizer that handles both
// quote styles and backslash escapes.
export function parseList(s: string | undefined | null): string[] {
  if (!s) return [];
  const t = s.trim();
  if (!t || t === '[]') return [];
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j.map((x) => String(x));
  } catch { /* fall through to tokenizer */ }
  const out: string[] = [];
  let cur = '';
  let q: string | null = null; // current quote char, or null when outside a string
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '\\' && i + 1 < t.length) { cur += t[++i]; continue; }
      if (c === q) { out.push(cur); cur = ''; q = null; continue; }
      cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
    }
    // chars outside strings ([ ] , whitespace) are ignored
  }
  return out;
}

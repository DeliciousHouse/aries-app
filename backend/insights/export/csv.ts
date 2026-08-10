/**
 * backend/insights/export/csv.ts
 *
 * S5-3 / AA-112 (gap F2a) — pure CSV serialization for the insights export.
 * No DB, no I/O.
 *
 * Two things this does beyond joining strings with commas:
 *
 * 1. RFC 4180 quoting. A field containing a comma, a quote, CR or LF is wrapped
 *    in quotes with inner quotes doubled. Captions and titles routinely contain
 *    all four, so an unquoted export silently shifts columns.
 *
 * 2. A formula-injection guard. A spreadsheet treats a cell beginning with
 *    `=`, `+`, `-`, `@`, TAB or CR as a formula, so an attacker-controlled
 *    caption like `=HYPERLINK("http://evil","click")` becomes live content in
 *    the operator's Excel. Captions here come from social platforms — i.e. from
 *    the public — so this is a real untrusted-input path, not a theoretical one.
 *    Such fields are prefixed with a single quote, which Excel/Sheets strip on
 *    display, and then quoted normally.
 */

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Neutralize a value a spreadsheet would evaluate. Returns the value unchanged
 * when it is not formula-shaped.
 */
export function neutralizeFormula(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_PREFIXES.includes(value[0]) ? `'${value}` : value;
}

/** Render one field: null/undefined → empty, numbers as-is, strings escaped. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  const raw = neutralizeFormula(String(value));
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/** One CSV record. RFC 4180 line ending. */
export function csvRow(values: readonly unknown[]): string {
  return `${values.map(csvField).join(',')}\r\n`;
}

/**
 * UTF-8 BOM. Excel on Windows assumes the legacy ANSI codepage for a .csv
 * without one, which mangles every non-ASCII character in a caption. The
 * operators these exports are for open them in Excel, so the BOM is the
 * correct default; parsers that dislike it are the rarer case here.
 */
export const CSV_BOM = '﻿';

/** `insights-posts-2026-08-05.csv` — safe for a Content-Disposition filename. */
export function csvFilename(dataset: string, now: Date = new Date()): string {
  const slug = dataset.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `insights-${slug}-${now.toISOString().slice(0, 10)}.csv`;
}

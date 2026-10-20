/**
 * The answer envelope and its byte budget. Column names once, rows as arrays, and at most
 * ANSWER_BUDGET_BYTES of JSON. Rows that do not fit go to a CSV file, and the answer says to narrow
 * the question rather than ask for the next page: paging a large result into a chat is how a client
 * spends its whole context and still has no answer.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import type pg from 'pg'

export const ANSWER_BUDGET_BYTES = 48_000

export type Answer = {
  status: string
  question: string
  columns: string[]
  rows: unknown[][]
  row_count: number
  rows_inline: number
  hint?: string
  download?: string
  sql: string // what ran
  planned_sql?: string // what the planner wrote, when the service changed it (a LIMIT)
  assumptions: string[]
  gaps: string[]
  warnings: string[]
  freshness: Array<{ relation: string; loaded_at: string }>
}
export type Base = Omit<Answer, 'rows' | 'rows_inline' | 'row_count' | 'hint' | 'download'>

export const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x))

export function envelope(base: Base, rows: unknown[][], budget = ANSWER_BUDGET_BYTES, outDir = 'out/answers'): Answer {
  const make = (k: number): Answer => {
    const a: Answer = { ...base, rows: rows.slice(0, k), row_count: rows.length, rows_inline: k }
    if (k < rows.length) {
      a.hint = `${rows.length - k} more rows are in the download. Narrow the question (one account, one region, a shorter date range) instead of asking for the next page.`
      a.download = `${outDir}/${createHash('sha256').update(base.question).digest('hex').slice(0, 8)}.csv`
    }
    return a
  }
  if (bytes(make(rows.length)) <= budget) return make(rows.length)
  // Largest k that fits, by binary search over the serialised size.
  let lo = 0, hi = rows.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (bytes(make(mid)) <= budget) lo = mid
    else hi = mid - 1
  }
  const a = make(lo)
  mkdirSync(outDir, { recursive: true })
  const cell = (v: unknown) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v))
  writeFileSync(a.download!, [base.columns, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n')
  return a
}

/** The broken shape: every row an object with its keys repeated, served a page at a time. Returns each page's bytes. */
export function pagedObjects(columns: string[], rows: unknown[][], pageSize = 500): number[] {
  const pages: number[] = []
  for (let i = 0; i < rows.length; i += pageSize)
    pages.push(bytes({ rows: rows.slice(i, i + pageSize).map((r) => Object.fromEntries(columns.map((c, j) => [c, r[j]]))), next_page: i / pageSize + 2 }))
  return pages
}

/** Share of bytes per part, summed over many answers. */
export function breakdown(answers: Answer[]): Array<[string, number]> {
  const parts: Record<string, number> = { rows: 0, freshness: 0, warnings: 0, sql: 0, assumptions: 0, columns: 0, question: 0, 'keys, status, counts, hint': 0 }
  let total = 0
  for (const a of answers) {
    const all = bytes(a)
    total += all
    const each = { rows: bytes(a.rows), freshness: bytes(a.freshness), warnings: bytes(a.warnings), sql: bytes(a.sql) + (a.planned_sql ? bytes(a.planned_sql) : 0), assumptions: bytes([...a.assumptions, ...a.gaps]), columns: bytes(a.columns), question: bytes(a.question) }
    for (const [k, v] of Object.entries(each)) parts[k]! += v
    parts['keys, status, counts, hint']! += all - Object.values(each).reduce((s, v) => s + v, 0)
  }
  return Object.entries(parts).map(([k, v]) => [k, v / total])
}

export async function logAnswer(db: pg.Pool, a: Answer, critic: string): Promise<void> {
  await db.query('INSERT INTO app.answer_log (question, status, bytes, rows_inline, rows_total, critic) VALUES ($1, $2, $3, $4, $5, $6)',
    [a.question, a.status, bytes(a), a.rows_inline, a.row_count, critic])
}

import type pg from 'pg'

export type Result = { columns: string[]; rows: unknown[][] }
export const STATEMENT_TIMEOUT_MS = 5_000

/**
 * The second guard, independent of the parser: a read-only transaction, a statement timeout, and a
 * role that can read the semantic views and nothing else. If the parser let a bad plan through,
 * Postgres refuses it here.
 */
export async function runReadOnly(db: pg.Pool, sql: string, timeoutMs = STATEMENT_TIMEOUT_MS): Promise<Result> {
  return inTransaction(db, ['BEGIN READ ONLY', `SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`, 'SET LOCAL ROLE acme_ask_reader', 'SET LOCAL search_path = semantic'], sql)
}

/** The broken path: the app's own connection, which owns every schema. Rolled back, so the demo stays repeatable. */
export async function runUnguarded(db: pg.Pool, sql: string): Promise<Result & { rowCount: number }> {
  return inTransaction(db, ['BEGIN', 'SET LOCAL search_path = semantic, public'], sql)
}

async function inTransaction(db: pg.Pool, prelude: string[], sql: string) {
  const c = await db.connect()
  try {
    for (const s of prelude) await c.query(s)
    const r = await c.query({ text: sql, rowMode: 'array' })
    return { columns: (r.fields ?? []).map((f) => f.name), rows: r.rows as unknown[][], rowCount: r.rowCount ?? 0 }
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    c.release()
  }
}

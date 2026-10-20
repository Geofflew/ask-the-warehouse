import { readFileSync } from 'node:fs'
import pg from 'pg'

// .env is optional: DATABASE_URL may come from the shell instead.
try {
  process.loadEnvFile()
} catch {}

// Dates stay strings and counts stay numbers, so output does not depend on the machine's time zone.
pg.types.setTypeParser(1082, (v) => v)
pg.types.setTypeParser(20, Number)
pg.types.setTypeParser(1700, Number)

/** The warehouse's fixed "today". */
export const AS_OF = '2025-12-31'

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/acme_ask'

export function connect(): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max: 4, options: '-c TimeZone=UTC' })
}

export async function setup(db: pg.Pool): Promise<void> {
  await db.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
}

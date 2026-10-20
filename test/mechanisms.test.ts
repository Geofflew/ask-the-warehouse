// One block per mechanism, each written to fail if its guard is removed. Needs DATABASE_URL; it
// regenerates the synthetic data, so point it at a database you do not mind rebuilding.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generate } from '../scripts/generate.ts'
import { ANSWER_BUDGET_BYTES, bytes, envelope } from '../src/answer.ts'
import { ask, overlookedColumns } from '../src/ask.ts'
import { connect } from '../src/db.ts'
import { cloneDocs, exposure, loadDocs, type Docs } from '../src/docs.ts'
import { loadBank, mcnemar, runBank, score } from '../src/eval.ts'
import { runReadOnly } from '../src/execute.ts'
import { FORECASTING_RULE, SCRIPT, SMALLER, ScriptedModel } from '../src/model.ts'
import { check, MAX_ROWS } from '../src/policy.ts'
import { render, retrieve, trace } from '../src/retrieve.ts'

const db = connect()
const model = new ScriptedModel()
const docs = loadDocs()
const exposed = exposure(docs)
const bank = loadBank()
const q = (id: string) => bank.find((c) => c.id === id)!.question
const oracle = async (id: string) => (await db.query({ text: bank.find((c) => c.id === id)!.oracle!, rowMode: 'array' })).rows as unknown[][]
const refusal = (sql: string, d = exposed) => { const c = check(sql, d); return c.ok ? 'passed' : c.rule }

beforeAll(async () => generate(db), 60_000)
afterAll(async () => db.end())

describe('1. plan check and read-only execution', () => {
  it('refuses relations, columns, functions and statements outside the allowlist, by rule', () => {
    expect(refusal('SELECT name, comp_band FROM raw.staff')).toBe('relation_not_exposed')
    expect(refusal('SELECT usename FROM pg_user')).toBe('relation_not_exposed')
    expect(refusal("DELETE FROM support_tickets WHERE status = 'closed'")).toBe('select_only')
    expect(refusal('WITH x AS (DELETE FROM deals RETURNING deal_id) SELECT * FROM x')).toBe('select_only')
    expect(refusal('SELECT pg_sleep(1)')).toBe('function_not_allowed')
    expect(refusal('SELECT name FROM accounts a WHERE EXISTS (SELECT 1 FROM deals d WHERE d.account_id = a.account_id)')).toBe('subquery_form_not_allowed')
    expect(refusal('SELECT a.secret FROM accounts a')).toBe('column_not_exposed')
    expect(refusal('SELECT 1; SELECT 2')).toBe('one_statement')
    expect(refusal("SELECT region, count(*) AS n FROM accounts WHERE status = 'customer' GROUP BY region ORDER BY n")).toBe('passed')
  })
  it('refuses a wildcard, so a column taken out of the docs stays unreadable; count(*) is a call and passes', () => {
    const d = cloneDocs(docs), accounts = d.relations.find((r) => r.name === 'accounts')!
    accounts.columns = accounts.columns.filter((c) => c.name !== 'account_owner')
    expect(refusal('SELECT account_owner FROM accounts', exposure(d))).toBe('column_not_exposed')
    expect(refusal('SELECT * FROM accounts', exposure(d))).toBe('wildcard_not_allowed')
    expect(refusal('SELECT a.* FROM accounts a', exposure(d))).toBe('wildcard_not_allowed')
    expect(refusal('SELECT name FROM (SELECT * FROM accounts) s', exposure(d))).toBe('wildcard_not_allowed')
    expect(refusal("SELECT count(*) FROM accounts WHERE status = 'customer'", exposure(d))).toBe('passed')
  })
  it('an output alias does not launder a column: aliases count only as bare ORDER BY names, CTE columns only in their scope', () => {
    const d = cloneDocs(docs), accounts = d.relations.find((r) => r.name === 'accounts')!
    accounts.columns = accounts.columns.filter((c) => c.name !== 'account_owner')
    const e = exposure(d)
    expect(refusal('SELECT account_owner AS account_owner FROM accounts LIMIT 1', e)).toBe('column_not_exposed')
    expect(refusal("SELECT name AS account_owner FROM accounts WHERE account_owner = 'x'", e)).toBe('column_not_exposed')
    expect(refusal('SELECT name AS account_owner FROM accounts ORDER BY account_owner', e)).toBe('passed')
    expect(refusal('WITH t AS (SELECT region, count(*) AS n FROM accounts GROUP BY region) SELECT region, n FROM t ORDER BY n', e)).toBe('passed')
    expect(refusal('WITH t AS (SELECT name AS account_owner FROM accounts) SELECT account_owner FROM accounts', e)).toBe('column_not_exposed')
  })
  it('keeps an OFFSET when it lowers the LIMIT', () => {
    const only = check('SELECT account_id FROM accounts ORDER BY account_id OFFSET 5', exposed, 10)
    expect(only.ok && only.sql).toMatch(/OFFSET \(?5\)?\s*LIMIT \(?11/)
    const both = check('SELECT account_id FROM accounts ORDER BY account_id LIMIT 500 OFFSET 5', exposed, 10)
    expect(both.ok && both.sql).toMatch(/OFFSET \(?5\)?\s*LIMIT \(?11/)
  })
  it('fetches one row past the cap, and leaves a plan LIMIT at or under the cap alone', () => {
    const c = check('SELECT name FROM accounts LIMIT 999999', exposed)
    expect(c.ok && c.sql).toMatch(new RegExp(`LIMIT \\(?${MAX_ROWS + 1}`))
    const own = check('SELECT name FROM accounts LIMIT 50', exposed)
    expect(own.ok && own.sql).toBe('SELECT name FROM accounts LIMIT 50')
  })
  it('marks a capped answer partial, names the cap, and reports the SQL that ran', async () => {
    const o = await ask(db, q('daily_usage'), model, { maxRows: 1000, log: false }) // 4,000 rows match
    expect(o.status).toBe('answered_in_part')
    expect(o.result!.rows).toHaveLength(1000)
    expect(o.answer!.gaps.join(' ')).toMatch(/more than 1000 rows/)
    expect(o.answer!.sql).toMatch(/LIMIT \(?1001/)
    expect(o.answer!.planned_sql).toBe(o.plan.sql)
    const fits = await ask(db, q('daily_usage'), model, { maxRows: 4000, log: false }) // exactly at the cap: complete
    expect(fits.status).toBe('answered')
    expect(fits.result!.rows).toHaveLength(4000)
  })
  it('refuses inside Postgres even when the parser is skipped', async () => {
    await expect(runReadOnly(db, 'SELECT comp_band FROM raw.staff')).rejects.toThrow(/permission denied/)
    await expect(runReadOnly(db, 'CREATE TEMP TABLE t (i int)')).rejects.toThrow(/read-only transaction/)
    await expect(runReadOnly(db, 'SELECT pg_sleep(2)', 100)).rejects.toThrow(/statement timeout/)
  })
  it('documents exactly the columns each semantic view has', async () => {
    for (const r of docs.relations) {
      const { rows } = await db.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position', ['semantic', r.name])
      expect(r.columns.map((c) => c.name), r.name).toEqual(rows.map((x) => x.column_name))
    }
  })
})

describe('2. risk-routed critic', () => {
  const risks = (sql: string) => { const c = check(sql, exposed); return c.ok ? c.risks : c.rule }
  it('skips a flat single-table select and names each risk otherwise', () => {
    expect(risks("SELECT name FROM accounts WHERE status = 'churned'")).toEqual([])
    expect(risks('SELECT a.name FROM accounts a JOIN deals d ON d.account_id = a.account_id')).toEqual(['join'])
    expect(risks('SELECT region, count(*) FROM accounts GROUP BY region')).toEqual(['aggregation'])
    expect(risks('SELECT name, rank() OVER (ORDER BY name) FROM accounts')).toEqual(['window'])
    expect(risks("SELECT name FROM accounts WHERE customer_since >= '2024-01-01'")).toEqual(['time_boundary'])
    expect(risks('SELECT name FROM accounts UNION SELECT name FROM staff')).toEqual(['join', 'set_operation'])
    expect(risks('SELECT name FROM accounts WHERE account_id IN (SELECT account_id FROM deals)')).toEqual(['join'])
  })
  it('does not call the critic on a flat plan', async () => {
    const o = await ask(db, q('churned_list'), model, { log: false })
    expect(o.critic.verdict).toBe('skipped')
  })
})

describe('3. critic notes are corrections', () => {
  it('promotes a note naming an unread bundle column to a revision, and the right count comes back', async () => {
    const [[truth]] = await oracle('signed_and_churned') as [[number]]
    const broken = await ask(db, q('signed_and_churned'), model, { promoteNotes: false, log: false })
    const guarded = await ask(db, q('signed_and_churned'), model, { log: false })
    expect(broken.result!.rows[0]![0]).not.toBe(truth)
    expect(guarded.critic.overlooked).toEqual(['accounts.customer_since'])
    expect(guarded.result!.rows[0]![0]).toBe(truth)
  })
  it('leaves a note alone when the column is already read or is not in the bundle', () => {
    const entities = retrieve(q('signed_and_churned'), docs).entities
    expect(overlookedColumns(['use customer_since'], entities, ['accounts.customer_since'])).toEqual([])
    expect(overlookedColumns(['use first_signed_on'], entities, [])).toEqual([])
    expect(overlookedColumns(['use customer_since'], entities, ['deals.closed_on'])).toEqual(['accounts.customer_since'])
  })
})

describe('4. the four retrieval channels', () => {
  const fq = q('forecasting_won')
  const noConcept = () => { const x = cloneDocs(docs); x.concepts = x.concepts.filter((c) => c.name !== 'forecasting'); return x }
  const deals = (x: Docs) => x.relations.find((r) => r.name === 'deals')!
  const rule = `${FORECASTING_RULE}.`
  const reaches = (question: string, x: Docs) => {
    const [t] = trace(question, x, FORECASTING_RULE)
    expect(t!.reached).toBe(render(retrieve(question, x)).includes(FORECASTING_RULE))
    return t!
  }
  it('(a) never renders a prose section', () => {
    const x = noConcept(); deals(x).prose.push(`## Notes\n${rule}`)
    expect(reaches(fq, x)).toMatchObject({ channel: 'a', reached: false })
  })
  it('(b) drops the description of a column the question does not name', () => {
    const x = noConcept(); deals(x).columns.find((c) => c.name === 'products')!.description += rule
    expect(reaches(fq, x)).toMatchObject({ channel: 'b', reached: false })
    expect(reaches('Which products were on the forecasting deals won in 2025?', x).reached).toBe(true)
  })
  it('(c) renders a relation ranked 4th or lower compact', () => {
    const x = noConcept(); deals(x).columns.find((c) => c.name === 'products')!.description += rule
    expect(reaches('Which regions, owners, open tickets and active users do customers with forecasting products have?', x)).toMatchObject({ channel: 'c', reached: false })
  })
  it('(d) fires a concept only on a synonym, and the plan changes only when the rule arrives', async () => {
    const x = cloneDocs(docs); x.concepts.find((c) => c.name === 'forecasting')!.synonyms = ['forecasting customer']
    expect(reaches(fq, x)).toMatchObject({ channel: 'd', reached: false })
    expect(reaches(fq, docs)).toMatchObject({ channel: 'd', reached: true })
    const want = (await oracle('forecasting_won')).map((r) => r[0]).sort()
    const got = async (d: Docs) => (await ask(db, fq, model, { docs: d, log: false })).result!.rows.map((r) => r[0]).sort()
    expect(await got(x)).not.toEqual(want)
    expect(await got(docs)).toEqual(want)
  })
})

describe('5. a two-table rule becomes a column', () => {
  it('refuses the column when it is undocumented, and answers right once it is', async () => {
    const before = cloneDocs(docs)
    const accounts = before.relations.find((r) => r.name === 'accounts')!
    accounts.columns = accounts.columns.filter((c) => c.name !== 'account_owner')
    expect(refusal("SELECT account_owner FROM accounts WHERE status = 'prospect'", exposure(before))).toBe('column_not_exposed')
    const right = new Map((await oracle('prospect_owner')).map((r) => [r[0], r[1]]))
    const ok = async (d: Docs) => (await ask(db, q('prospect_owner'), model, { docs: d, log: false })).result!.rows.filter((r) => right.get(r[0]) === r[1]).length
    expect(await ok(before)).toBe(0)
    expect(await ok(docs)).toBe(right.size)
  })
})

describe('7. answer budget', () => {
  it('caps the answer, says to filter, writes every row to the download, and logs bytes and rows', async () => {
    await db.query('TRUNCATE app.answer_log')
    rmSync('out/answers', { recursive: true, force: true }) // a file from an earlier run must not pass this test
    const o = await ask(db, q('daily_usage'), model)
    const a = o.answer!
    expect(o.result!.rows.length).toBe(4000)
    expect(bytes(a)).toBeLessThanOrEqual(ANSWER_BUDGET_BYTES)
    expect(a.rows_inline).toBeLessThan(a.row_count)
    expect(a.hint).toMatch(/Narrow the question/)
    expect(readFileSync(a.download!, 'utf8').trim().split('\n')).toHaveLength(4001)
    const { rows } = await db.query('SELECT bytes, rows_inline, rows_total FROM app.answer_log')
    expect(rows).toEqual([{ bytes: bytes(a), rows_inline: a.rows_inline, rows_total: 4000 }])
  })
  it('leaves an answer that fits alone', () => {
    const a = envelope({ status: 'answered', question: 'x', columns: ['n'], sql: '', assumptions: [], gaps: [], warnings: [], freshness: [] }, [[1], [2]])
    expect(a).toMatchObject({ rows_inline: 2, row_count: 2 })
    expect(a.download).toBeUndefined()
    expect(existsSync('out/answers')).toBe(true)
  })
})

describe('8. eval harness', () => {
  it('scores every bank question and finds the planted miss', async () => {
    expect(bank.every((c) => SCRIPT[c.question])).toBe(true)
    const runs = await runBank(db, bank, model)
    expect(runs.filter((r) => !r.pass).map((r) => r.id)).toEqual(['tickets_per_customer'])
    expect(runs.find((r) => r.id === 'emea_nps')!.score).toBe('answered_in_part')
  })
  it('scores wrong rows as wrong, not as answered', async () => {
    const c = bank.find((x) => x.id === 'customers_by_region')!
    const o = await ask(db, c.question, model, { log: false })
    o.result!.rows[0]![1] = 999
    expect(await score(db, c, o)).toBe('wrong')
  })
  it('compares two models on the questions where they disagree', async () => {
    const a = (await runBank(db, bank, model)).map((r) => r.pass)
    const b = (await runBank(db, bank, new ScriptedModel(SMALLER))).map((r) => r.pass)
    expect(mcnemar(a, b)).toEqual({ onlyA: 3, onlyB: 1, p: 0.625 })
    expect(mcnemar([true, false], [true, false]).p).toBe(1)
  })
})

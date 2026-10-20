/**
 * Eight sections, one per mechanism. Each prints BROKEN, then GUARDED, then the difference.
 * Reads the data `pnpm generate` wrote. The planner and critic are scripted (src/model.ts): the
 * thing that varies between BROKEN and GUARDED is the plumbing or the docs, never the model.
 */
import { readFileSync } from 'node:fs'
import { ask, type Outcome } from '../src/ask.ts'
import { breakdown, bytes, pagedObjects, type Answer } from '../src/answer.ts'
import { AS_OF, connect } from '../src/db.ts'
import { cloneDocs, exposure, loadDocs, parseRelation, type Docs } from '../src/docs.ts'
import { loadBank, mcnemar, runBank } from '../src/eval.ts'
import { runReadOnly, runUnguarded } from '../src/execute.ts'
import { FORECASTING_RULE, SCRIPT, SMALLER, ScriptedModel } from '../src/model.ts'
import { check, MAX_ROWS } from '../src/policy.ts'
import { medianPromptBytes, PROMPT_CEILING_BYTES as CEILING, render, retrieve, trace } from '../src/retrieve.ts'

const out = (s = '') => console.log(s)
const section = (n: number, title: string) => out(`\n${'='.repeat(78)}\n${n}. ${title}\n${'='.repeat(78)}`)
const label = (tag: 'BROKEN' | 'GUARDED' | 'DIFF' | 'NOTE', text: string) => out(`${tag.padEnd(8)} ${text.split('\n').join('\n         ')}`)
const kb = (n: number) => `${(n / 1000).toFixed(1)}KB`
const pct = (x: number) => `${Math.round(x * 100)}%`

const db = connect()
const model = new ScriptedModel()
const shipped = loadDocs()
const bank = loadBank()
const q = (id: string) => bank.find((c) => c.id === id)!.question
const oracle = async (id: string) => (await db.query({ text: bank.find((c) => c.id === id)!.oracle!, rowMode: 'array' })).rows as unknown[][]
const errorOf = async (p: Promise<unknown>) => p.then(() => 'ran', (e: Error) => e.message)

try {
  await db.query('TRUNCATE app.answer_log RESTART IDENTITY')
  const [{ a, d }] = (await db.query('SELECT (SELECT count(*) FROM raw.accounts) a, (SELECT count(*) FROM raw.deals) d')).rows
  if (!a) throw new Error('no data: run `pnpm generate` first')
  out(`Acme Analytics, as of ${AS_OF}: ${a} accounts, ${d} deals. Planner and critic: ${model.name} (no API key, deterministic).`)

  // ── 1 ──
  section(1, 'Plan check over the documented schema, and read-only execution')
  for (const id of ['staff_comp', 'delete_tickets']) {
    const sql = SCRIPT[q(id)]!.plan as string
    out(`Q: ${q(id)}\n   plan: ${sql}`)
    const r = await runUnguarded(db, sql)
    label('BROKEN', id === 'staff_comp'
      ? `run as the app's own connection: ${r.rows.length} rows, e.g. ${JSON.stringify(r.rows[0])}`
      : `run as the app's own connection: ${r.rowCount} tickets deleted (rolled back here so the demo repeats)`)
    const c = check(sql, exposure(shipped))
    label('GUARDED', `plan check refused: ${c.ok ? 'passed?' : `${c.rule} (${c.detail})`}\n` +
      `and if the check were skipped, the reader role says: ${await errorOf(runReadOnly(db, sql))}`)
  }
  label('DIFF', 'two independent guards: the parser refuses by rule before anything runs; the role and the read-only\n' +
    'transaction refuse inside Postgres if a plan ever got past the parser.')
  for (const sql of ["SELECT name, pg_sleep(10) FROM accounts", 'SELECT * FROM accounts', "SELECT name FROM accounts WHERE status = 'customer'"]) {
    const c = check(sql, exposure(shipped))
    out(`${sql}\n         -> ${c.ok ? `passes; runs as: ${c.sql}` : `refused: ${c.rule} (${c.detail})`}`)
  }
  const cap = 1000, uplan = SCRIPT[q('daily_usage')]!.plan as string
  out(`Q: ${q('daily_usage')}  (row cap lowered to ${cap} for this run; shipped cap ${MAX_ROWS})`)
  const plain = await runReadOnly(db, `${uplan} LIMIT ${cap}`)
  label('BROKEN', `LIMIT ${cap}: ${plain.rows.length} rows back, and nothing in them says whether that is all of it`)
  const capped = await ask(db, q('daily_usage'), model, { maxRows: cap, log: false })
  label('GUARDED', `ran: ...${capped.answer!.sql.slice(-12)}; one row past the cap came back, so status ${capped.status}, ${capped.result!.rows.length} rows kept\n` +
    `gap: ${capped.answer!.gaps.at(-1)}`)

  // ── 2 ──
  section(2, 'Risk-routed critic: runs only on joins, aggregates, windows, time boundaries, set operations')
  let fired = 0, checked = 0
  for (const c of bank) {
    const plan = model.plan(c.question, render(retrieve(c.question, shipped)))
    const v = check(plan.sql!, exposure(shipped))
    if (!v.ok) continue
    checked++
    if (v.risks.length) fired++
    out(`  ${c.id.padEnd(22)} ${v.risks.length ? `critic runs: ${v.risks.join(', ')}` : 'critic skipped: flat single-table select'}`)
  }
  label('NOTE', `the critic ran on ${fired} of ${checked} plans that passed the check, not ${checked}. The limit of routing: prospect_owner\n` +
    `is skipped, and in section 5's broken schema that flat SELECT reads the wrong column. A wrong column carries no structural risk.`)

  // ── 3 ──
  section(3, 'Critic notes are corrections')
  const sc = q('signed_and_churned')
  const truth3 = (await oracle('signed_and_churned'))[0]![0]
  const b3 = await ask(db, sc, model, { promoteNotes: false })
  out(`Q: ${sc}\n   plan: ${b3.plan.sql}\n   critic: approve, note: ${b3.critic.notes[0]}`)
  label('BROKEN', `note shipped as a caveat; the plan ran as written: ${b3.result!.rows[0]![0]} customers (oracle: ${truth3})`)
  const g3 = await ask(db, sc, model)
  label('GUARDED', `note names ${g3.critic.overlooked.join(', ')}: a column of a relation in the bundle that no statement reads\n` +
    `-> promoted to a revision: ${g3.plan.sql}\n-> ${g3.result!.rows[0]![0]} customers (oracle: ${truth3})`)
  const acv = await ask(db, q('acv_by_region'), model, { log: false })
  label('NOTE', `acv_by_region's note names start_on and end_on, which the plan reads: it stays a caveat (${acv.critic.verdict}).`)

  // ── 4 ──
  section(4, 'The four retrieval channels: where a rule is written decides whether the planner sees it')
  const fq = q('forecasting_won')
  const want = new Set((await oracle('forecasting_won')).map((r) => r[0]))
  const rule = `${FORECASTING_RULE}: match products ILIKE '%Horizon%'.`
  const without = () => { const x = cloneDocs(shipped); x.concepts = x.concepts.filter((c) => c.name !== 'forecasting'); return x }
  const deals = (x: Docs) => x.relations.find((r) => r.name === 'deals')!
  const products = (x: Docs) => deals(x).columns.find((c) => c.name === 'products')!
  const variants: Array<[string, string, Docs]> = []
  { const x = without(); deals(x).prose.push(`## Selling notes\n${rule}`); variants.push(['(a) prose section under the table', fq, x]) }
  { const x = without(); products(x).description += ` ${rule}`; variants.push(['(b) products column description', fq, x]) }
  const cq = 'Which regions, owners, open tickets and active users do customers with forecasting products have?'
  { const x = without(); products(x).description += ` ${rule}`; variants.push(['(c) same column, other question', cq, x]) }
  { const x = cloneDocs(shipped); x.concepts.find((c) => c.name === 'forecasting')!.synonyms = ['forecasting customer', 'on forecasting']; variants.push(['(d) concept, customer synonyms', fq, x]) }
  variants.push(['(d) concept + "forecasting deal"', fq, shipped])
  out(`Q: ${fq}   (oracle: ${want.size} deals; c uses: "${cq}")`)
  for (const [where, question, docs] of variants) {
    const t = trace(question, docs, FORECASTING_RULE)[0]!
    let rows = ''
    if (question === fq) {
      const o = await ask(db, question, model, { docs, log: false })
      const got = o.result!.rows.map((r) => r[0])
      rows = ` -> ${got.length} rows, ${got.filter((x) => want.has(x)).length} right`
    }
    label(t.reached ? 'GUARDED' : 'BROKEN', `${where.padEnd(36)} ${t.reached ? 'reached' : 'dark   '}  ${t.why}${rows}`)
  }
  label('DIFF', 'same rule text, same scripted planner; only where the rule is written changed. The wrong plan matches\n' +
    '"forecast" in deal names and notes, which mention products discussed, not bought.')

  // ── 5 ──
  section(5, 'A two-table rule becomes one column')
  const pq = q('prospect_owner')
  const right = new Map((await oracle('prospect_owner')).map((r) => [r[0], r[1]]))
  const before = cloneDocs(shipped)
  before.relations.find((r) => r.name === 'accounts')!.columns = before.relations.find((r) => r.name === 'accounts')!.columns.filter((c) => c.name !== 'account_owner')
  Object.assign(before.concepts.find((c) => c.name === 'account_owner')!, {
    column: 'owner_name',
    rule: "For a customer the account owner is accounts.owner_name. For a prospect it is the owner_name of the prospect's open deal in deals (stage = 'open').",
  })
  const correct = (o: Outcome) => o.result!.rows.filter((r) => right.get(r[0]) === r[1]).length
  const b5 = await ask(db, pq, model, { docs: before })
  const t5 = trace(pq, before, 'For a prospect it is the owner_name')[0]!
  out(`Q: ${pq}`)
  label('BROKEN', `schema: no account_owner column; the rule is a concept (${t5.why}).\n` +
    `plan: ${b5.plan.sql}\nstatus ${b5.status}, critic ${b5.critic.verdict}: ${correct(b5)} of ${right.size} owners right (it read the first-touch SDR)`)
  const g5 = await ask(db, pq, model)
  label('GUARDED', `schema: accounts.account_owner does the branch in the view.\nplan: ${g5.plan.sql}\nstatus ${g5.status}: ${correct(g5)} of ${right.size} owners right`)
  label('DIFF', 'same scripted planner in both runs. It returns the right plan only when the prompt lists account_owner,\n' +
    'and is written to miss the two-table rule. What changed is the schema: one column, no rule.')

  // ── 6 ──
  section(6, 'Prompt byte ceiling as a test')
  const withDraft = (name: string) => { const x = cloneDocs(shipped); x.relations.push(parseRelation(readFileSync(new URL(`../semantic/drafts/invoices-${name}.md`, import.meta.url), 'utf8'))); return x }
  const entered = (x: Docs) => bank.filter((c) => retrieve(c.question, x).entities.some((e) => e.relation.name === 'invoices')).length
  const row = (tag: string, x: Docs) => {
    const m = medianPromptBytes(x, bank.map((c) => c.question))
    out(`  ${tag.padEnd(40)} median ${String(m).padStart(6)} bytes ${m < CEILING ? 'under' : 'OVER '} ${CEILING}   invoices in ${entered(x)} of ${bank.length} bundles`)
  }
  row('shipped docs', shipped)
  row('+ invoices, leaky description (BROKEN)', withDraft('leaky'))
  row('+ invoices, renamed + trimmed', withDraft('trimmed'))
  label('NOTE', 'none of these questions is about invoices. The leaky draft says "total", "deal", "customer" and names a\n' +
    'column `total`, and descriptions and column names are scored and rendered. test/prompt.test.ts fails on the leaky draft.')

  // ── 7 ──
  section(7, '48KB answer budget')
  const uq = q('daily_usage')
  const u = await ask(db, uq, model)
  const pages = pagedObjects(u.result!.columns, u.result!.rows)
  out(`Q: ${uq}  (${u.result!.rows.length} rows)`)
  label('BROKEN', `rows as objects, 500 a page: ${pages.length} pages of ~${kb(pages[0]!)} each, ${kb(pages.reduce((s, x) => s + x, 0))} into the client's context`)
  const ans = u.answer!
  label('GUARDED', `one answer of ${kb(bytes(ans))}: ${ans.rows_inline} of ${ans.row_count} rows inline, columns once, rows as arrays\n` +
    `hint: ${ans.hint}\ndownload: ${ans.download}`)
  const { rows: log } = await db.query('SELECT id, left(question, 44) AS question, status, bytes, rows_inline, rows_total, critic FROM app.answer_log ORDER BY id')
  out('answer log:')
  for (const l of log) out(`  ${String(l.id).padStart(2)} ${l.question.padEnd(44)} ${l.status.padEnd(16)} ${String(l.bytes).padStart(6)} B  ${String(l.rows_inline).padStart(4)}/${String(l.rows_total).padEnd(4)} rows  critic ${l.critic}`)
  const answers: Answer[] = []
  for (const c of bank) { const o = await ask(db, c.question, model, { log: false }); if (o.answer) answers.push(o.answer) }
  out(`bytes by part over the bank's ${answers.length} answers: ${breakdown(answers).map(([k, v]) => `${k} ${pct(v)}`).join(', ')}`)
  const small = answers.filter((x) => x.row_count <= 20)
  out(`the same over the ${small.length} answers of 20 rows or fewer: ${breakdown(small).map(([k, v]) => `${k} ${pct(v)}`).join(', ')}`)

  // ── 8 ──
  section(8, 'Eval harness: question bank with SQL oracles, paired comparison')
  const small2 = new ScriptedModel(SMALLER, 'scripted-small')
  const A = await runBank(db, bank, model), B = await runBank(db, bank, small2)
  out(`  ${'question'.padEnd(22)} ${model.name.padEnd(18)} ${small2.name}`)
  bank.forEach((c, i) => out(`  ${c.id.padEnd(22)} ${`${A[i]!.score}${A[i]!.pass ? '' : ' x'}`.padEnd(18)} ${B[i]!.score}${B[i]!.pass ? '' : ' x'}`))
  const tally = (r: typeof A) => `${r.filter((x) => x.pass).length}/${r.length} pass`
  const m = mcnemar(A.map((x) => x.pass), B.map((x) => x.pass))
  out(`  ${'total'.padEnd(22)} ${tally(A).padEnd(18)} ${tally(B)}`)
  label('NOTE', `McNemar exact: only ${model.name} passed ${m.onlyA}, only ${small2.name} passed ${m.onlyB}, p = ${m.p.toFixed(3)}.\n` +
    `${A.filter((x) => x.pass).length - B.filter((x) => x.pass).length} more passes is not evidence of a difference on a bank this size; the ${A.filter((x, i) => x.pass === B[i]!.pass).length} questions\n` +
    'where the two agree carry no information about which is better.')
} finally {
  await db.end()
}

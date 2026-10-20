/**
 * Question in, answer out: retrieve -> plan -> check -> critic (only on structural risk) -> execute
 * read-only -> answer within the byte budget -> log.
 */
import type pg from 'pg'
import { envelope, logAnswer, type Answer } from './answer.ts'
import { exposure, loadDocs, type Docs } from './docs.ts'
import { runReadOnly, type Result } from './execute.ts'
import type { Model, Plan } from './model.ts'
import { check, MAX_ROWS, type Checked, type Refused, type Risk } from './policy.ts'
import { render, retrieve, type Bundle, type Entity } from './retrieve.ts'

export type Options = { docs?: Docs; promoteNotes?: boolean; budget?: number; log?: boolean; maxRows?: number }
export type Outcome = {
  status: 'answered' | 'answered_in_part' | 'unsupported' | 'refused'
  bundle: Bundle
  prompt: string
  plan: Plan
  refusal?: Refused
  critic: { risks: Risk[]; verdict: 'skipped' | 'approved' | 'approved_with_notes' | 'revised'; notes: string[]; overlooked: string[] }
  result?: Result
  answer?: Answer
}

/**
 * A critic note that names a real column of a relation in the bundle, when no statement in the
 * plan reads that column, is a correction phrased politely. Proved against the column lists: the
 * note's words are never judged, only matched. ponytail: only snake_case words are candidates, so
 * a note naming a one-word column ("region") stays a note.
 */
export function overlookedColumns(notes: string[], entities: Entity[], read: string[]): string[] {
  const readNames = new Set(read.map((c) => c.split('.')[1]))
  const found = new Set<string>()
  for (const word of notes.join(' ').match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])
    for (const e of entities)
      if (e.relation.columns.some((c) => c.name === word) && !readNames.has(word)) found.add(`${e.relation.name}.${word}`)
  return [...found]
}

export async function ask(db: pg.Pool, question: string, model: Model, opts: Options = {}): Promise<Outcome> {
  const docs = opts.docs ?? loadDocs()
  const exposed = exposure(docs)
  const maxRows = opts.maxRows ?? MAX_ROWS
  const bundle = retrieve(question, docs)
  const prompt = render(bundle)
  let plan = model.plan(question, prompt)
  const out: Outcome = { status: 'unsupported', bundle, prompt, plan, critic: { risks: [], verdict: 'skipped', notes: [], overlooked: [] } }
  if (!plan.sql) return out

  let checked: Checked | Refused = check(plan.sql, exposed, maxRows)
  if (!checked.ok) return { ...out, status: 'refused', refusal: checked }

  const warnings = [...checked.warnings]
  out.critic.risks = checked.risks
  if (checked.risks.length) {
    const review = model.review(question, prompt, plan)
    out.critic.notes = review.notes
    out.critic.verdict = review.verdict === 'revise' ? 'revised' : review.notes.length ? 'approved_with_notes' : 'approved'
    if (review.verdict === 'approve' && review.notes.length && opts.promoteNotes !== false) {
      out.critic.overlooked = overlookedColumns(review.notes, bundle.entities, checked.columns)
      if (out.critic.overlooked.length) out.critic.verdict = 'revised'
    }
    if (out.critic.verdict === 'revised') {
      plan = out.plan = model.revise(question, prompt, plan, review.notes)
      checked = check(plan.sql!, exposed, maxRows)
      if (!checked.ok) return { ...out, status: 'refused', refusal: checked }
    } else {
      warnings.push(...review.notes.map((n) => `critic note: ${n}`))
    }
  }

  const result = await runReadOnly(db, checked.sql)
  const { rows: loads } = await db.query('SELECT relation, loaded_at FROM raw.loads WHERE relation = ANY($1) ORDER BY relation', [checked.relations])
  // A row past the cap means the SQL cut the result. The download cannot recover rows never fetched,
  // so the answer says it is partial instead of passing the cut off as the whole.
  const gaps = [...plan.gaps]
  if (result.rows.length > maxRows) {
    result.rows = result.rows.slice(0, maxRows)
    gaps.push(`row_cap: more than ${maxRows} rows matched and only ${maxRows} were fetched; narrow the question for the rest`)
  }
  const status = gaps.length ? 'answered_in_part' : 'answered'
  const answer = envelope({
    status, question, columns: result.columns, sql: checked.sql, ...(checked.sql !== plan.sql ? { planned_sql: plan.sql! } : {}),
    assumptions: plan.assumptions, gaps, warnings,
    freshness: loads.map((l) => ({ relation: l.relation, loaded_at: (l.loaded_at as Date).toISOString() })),
  }, result.rows, opts.budget)
  if (opts.log !== false) await logAnswer(db, answer, out.critic.verdict)
  return { ...out, status, result, answer }
}

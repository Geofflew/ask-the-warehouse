/**
 * The plan check. The planner's SQL is parsed into a syntax tree and walked; nothing is matched as
 * text. A plan passes only if it is one SELECT over documented relations and columns, calls only
 * listed functions, names its columns (no wildcard), and carries a LIMIT no larger than MAX_ROWS (the
 * cap plus one is imposed otherwise, so the caller can see the cut).
 * The same walk reports the plan's structural risks, which decide whether the critic runs.
 */
import { parse, toSql, type Statement } from 'pgsql-ast-parser'

export const MAX_ROWS = 10_000
export const FUNCTIONS = new Set(['count', 'sum', 'avg', 'min', 'max', 'round', 'coalesce', 'lower', 'date_trunc', 'nullif', 'rank', 'row_number'])
const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max'])
const READS = new Set(['select', 'union', 'union all', 'with'])

export type Risk = 'join' | 'aggregation' | 'window' | 'time_boundary' | 'set_operation'
export type Checked = { ok: true; sql: string; relations: string[]; columns: string[]; risks: Risk[]; warnings: string[] }
export type Refused = { ok: false; rule: string; detail: string }

type Node = { type?: string; [k: string]: unknown }
function walk(n: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(n)) n.forEach((x) => walk(x, visit))
  else if (n && typeof n === 'object') {
    visit(n as Node)
    Object.values(n).forEach((x) => walk(x, visit))
  }
}

export function check(sql: string, exposed: Map<string, Set<string>>, maxRows = MAX_ROWS): Checked | Refused {
  const refuse = (rule: string, detail: string): Refused => ({ ok: false, rule, detail })
  let stmts: Statement[]
  try {
    stmts = parse(sql)
  } catch (e) {
    return refuse('parse_error', (e as Error).message.split('\n')[0]!)
  }
  if (stmts.length !== 1) return refuse('one_statement', `${stmts.length} statements`)
  const top = stmts[0]!

  const nodes: Node[] = []
  walk(top, (n) => nodes.push(n))
  const writes = nodes.filter((n) => n.type && /^(insert|update|delete|create|drop|alter|truncate)/.test(n.type))
  if (!READS.has(top.type) || writes.length) return refuse('select_only', `statement type ${writes[0]?.type ?? top.type}`)

  // Relations. CTE names count as relations the plan defined itself; every other name must be documented.
  const ctes = new Set(nodes.flatMap((n) => (n.type === 'with' ? (n.bind as Array<{ alias: { name: string } }>).map((b) => b.alias.name) : [])))
  const alias = new Map<string, string>()
  const relations = new Set<string>()
  for (const n of nodes) {
    if (n.type !== 'table' || typeof (n.name as Node)?.name !== 'string') continue
    const { name, schema, alias: as } = n.name as { name: string; schema?: string; alias?: string }
    if (!schema && ctes.has(name)) continue
    if ((schema && schema !== 'semantic') || !exposed.has(name)) return refuse('relation_not_exposed', schema ? `${schema}.${name}` : name)
    relations.add(name)
    alias.set(as ?? name, name)
  }

  // Columns. Table aliases are resolved statement-wide, not per scope; a subquery that
  // reuses an alias for a different relation is checked against the last one. Fine for planner-sized SQL.
  //
  // An unqualified name that is not a documented column is legal SQL in two places only: an output
  // alias standing alone in ORDER BY of its own SELECT, or a column of a CTE or derived table in that
  // SELECT's FROM. Anywhere else (`SELECT account_owner AS account_owner`, `WHERE account_owner = ...`)
  // the name reads a real column, so it must be documented. Each ref is tagged with the names its
  // position allows; selects are visited outer to inner, so the innermost scope wins. GROUP BY
  // prefers an input column when an output alias collides with it. The docs cannot tell us which
  // undocumented input columns exist, so GROUP BY output aliases are not an escape from the
  // column allowlist. Repeat the documented input expression or use its ordinal instead.
  const outputNames = (s: Node | undefined): string[] =>
    Array.isArray(s?.columns) ? (s!.columns as Array<{ alias?: { name: string }; expr?: Node }>).map((c) => c.alias?.name ?? (c.expr?.type === 'ref' ? (c.expr.name as string) : '')) : []
  const derived = new Map<string, string[]>() // CTE or subquery alias -> the names it outputs
  for (const n of nodes) {
    if (n.type === 'with') for (const b of n.bind as Array<{ alias: { name: string }; statement: Node }>) derived.set(b.alias.name, outputNames(b.statement))
    if (n.type === 'statement' && (n.alias as { name?: string } | undefined)?.name) derived.set((n.alias as { name: string }).name, outputNames(n.statement as Node))
  }
  const allowed = new Map<Node, Set<string>>()
  for (const s of nodes.filter((n) => n.type === 'select')) {
    const fromNames: string[] = [] // joins are flat in `from`, one entry per joined relation
    for (const f of (s.from as Node[] | undefined) ?? []) {
      if (f.type === 'statement') fromNames.push((f.alias as { name: string }).name)
      else if (f.type === 'table' && !(f.name as { schema?: string }).schema) fromNames.push((f.name as { name: string }).name)
    }
    const scope = new Set(fromNames.filter((f) => derived.has(f)).flatMap((f) => derived.get(f)!))
    const own = new Set([...scope, ...outputNames(s)])
    const tag = (part: unknown, names: Set<string>) => walk(part, (n) => { if (n.type === 'ref') allowed.set(n, names) })
    tag([s.columns, s.from, s.where, s.having, s.groupBy, s.orderBy], scope)
    // Inside an ORDER BY expression, PostgreSQL reads input columns, never output aliases.
    // Only a bare, unqualified reference can name a SELECT output.
    for (const order of (s.orderBy as Array<{ by: Node }> | undefined) ?? []) {
      if (order.by.type === 'ref' && !order.by.table) allowed.set(order.by, own)
    }
  }
  const columns = new Set<string>()
  // count(*) is a call argument, not a column read. Any other * is refused rather than expanded: the
  // planner writes the SQL and can name its columns, and expanding would need the catalog at check time.
  const callStars = new Set(nodes.flatMap((n) => (n.type === 'call' ? (n.args as Node[]).filter((a) => a.type === 'ref' && a.name === '*' && !a.table) : [])))
  for (const n of nodes.filter((x) => x.type === 'ref')) {
    const name = n.name as string, qualifier = (n.table as { name: string } | undefined)?.name
    if (name === '*' && callStars.has(n)) continue
    if (name === '*') return refuse('wildcard_not_allowed', qualifier ? `${qualifier}.*` : '*')
    if (qualifier) {
      if (ctes.has(qualifier) && !alias.has(qualifier)) continue
      const rel = alias.get(qualifier)
      if (!rel || !exposed.get(rel)!.has(name)) return refuse('column_not_exposed', `${rel ?? qualifier}.${name}`)
      columns.add(`${rel}.${name}`)
    } else {
      const owners = [...relations].filter((r) => exposed.get(r)!.has(name))
      if (!owners.length && !allowed.get(n)?.has(name)) return refuse('column_not_exposed', name)
      owners.forEach((r) => columns.add(`${r}.${name}`))
    }
  }

  const calls = nodes.filter((n) => n.type === 'call') as Array<Node & { function: { name: string; schema?: string }; over?: unknown }>
  const bad = calls.find((c) => c.function.schema || !FUNCTIONS.has(c.function.name.toLowerCase()))
  // The parser reads EXISTS (...) as a call. Refused under its own name; NOT EXISTS needs scoping rules this check does not have.
  if (bad?.function.name.toLowerCase() === 'exists') return refuse('subquery_form_not_allowed', 'EXISTS (...)')
  if (bad) return refuse('function_not_allowed', [bad.function.schema, bad.function.name].filter(Boolean).join('.'))

  const risks = new Set<Risk>()
  if (relations.size > 1 || nodes.some((n) => n.type === 'table' && n.join) || nodes.some((n) => Array.isArray(n.from) && n.from.length > 1)) risks.add('join')
  if (nodes.some((n) => Array.isArray(n.groupBy)) || calls.some((c) => AGGREGATES.has(c.function.name.toLowerCase()) && !c.over)) risks.add('aggregation')
  if (calls.some((c) => c.over)) risks.add('window')
  if (nodes.some((n) => (n.type === 'keyword' && /^(current_date|now|current_timestamp)$/.test(n.keyword as string)) || n.type === 'extract' ||
      (n.type === 'string' && /^\d{4}-\d{2}-\d{2}/.test(n.value as string)) || (n.type === 'call' && (n.function as Node).name === 'date_trunc')))
    risks.add('time_boundary')
  if (nodes.some((n) => n.type === 'union' || n.type === 'union all' || n.distinct)) risks.add('set_operation')

  // LIMIT: the planner's own if it is at or under the cap. Otherwise the cap plus one, so the caller
  // can tell a result that was cut from one that happened to fit.
  const warnings: string[] = []
  let exec = sql
  const limit = (top as { limit?: { limit?: { type: string; value: number } } }).limit?.limit
  if (top.type !== 'select') {
    exec = `SELECT * FROM (${sql.replace(/;\s*$/, '')}) AS capped LIMIT ${maxRows + 1}`
  } else if (!limit || limit.type !== 'integer' || limit.value > maxRows) {
    // Only the limit changes; an OFFSET in the same clause stays, or the slice would start at the wrong row.
    ;(top as { limit?: object }).limit = { ...(top as { limit?: object }).limit, limit: { type: 'integer', value: maxRows + 1 } }
    exec = toSql.statement(top)
    if (limit) warnings.push(`limit_lowered: the plan asked for more than ${maxRows} rows`)
  }
  return { ok: true, sql: exec, relations: [...relations], columns: [...columns], risks: [...risks], warnings }
}

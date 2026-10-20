/**
 * Retrieval: rank relations lexically for a question, then render the planner prompt. Four places a
 * rule can be written, and each is closed in a different case:
 *   (a) a `## ...` prose section after the column table: never rendered;
 *   (b) a column description: dropped when the column is brief (the question does not name it);
 *   (c) anything on a relation ranked 4th or lower: rendered compact, every description dropped;
 *   (d) a concept: rendered at any rank, but only when one of its synonyms is in the question.
 * `trace` says which of these a given rule went through for a given question.
 */
import type { Column, Concept, Docs, Relation } from './docs.ts'

export const WHOLE = 3 // relations rendered whole; the rest compact
export const MAX_RELATIONS = 6

const STOP = new Set(('a an and are by did do does each every for from give has have how i in is it list many me ' +
  'most of on or our over per show than that the their them they this to was were what when which who with').split(' '))
const stem = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)
/** Lower-cased, stemmed words. Concepts match on these, stop words included ("who owns"). */
export const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem)
/** Words minus stop words: what relations are scored on. */
export const terms = (text: string) => words(text).filter((w) => !STOP.has(w))

export type Entity = { relation: Relation; rank: number; score: number; mode: 'whole' | 'compact'; named: Set<string> }
export type Fired = { concept: Concept; synonym: string }
export type Bundle = { question: string; entities: Entity[]; concepts: Fired[] }

function fields(r: Relation) {
  return {
    name: new Set(terms(r.name)),
    about: new Set(terms(`${r.description} ${r.grain}`)),
    columns: new Set(r.columns.flatMap((c) => terms(c.name))),
    text: new Set(r.columns.flatMap((c) => terms(`${c.description} ${c.limitation}`))),
  }
}

export function retrieve(question: string, docs: Docs): Bundle {
  const q = [...new Set(terms(question))]
  const f = docs.relations.map(fields)
  // Rarity weighting: a word every relation uses ("customer") counts for little, a rare one for a lot.
  const idf = (t: string) => Math.log(1 + docs.relations.length / Math.max(1, f.filter((x) => x.name.has(t) || x.about.has(t) || x.columns.has(t) || x.text.has(t)).length))
  const scored = docs.relations
    .map((relation, i) => {
      const x = f[i]!
      const score = q.reduce((s, t) => s + idf(t) * (4 * +x.name.has(t) + 2 * +x.about.has(t) + 2 * +x.columns.has(t) + +x.text.has(t)), 0)
      return { relation, score }
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.relation.name.localeCompare(b.relation.name))
    .slice(0, MAX_RELATIONS)

  const qs = new Set(q)
  const named = (c: Column) => terms(c.name).every((t) => qs.has(t))
  const entities: Entity[] = scored.map((e, i) => ({
    ...e, rank: i + 1, mode: i < WHOLE ? 'whole' : 'compact', named: new Set(e.relation.columns.filter(named).map((c) => c.name)),
  }))

  const said = ` ${words(question).join(' ')} `
  const concepts: Fired[] = []
  for (const concept of docs.concepts) {
    const synonym = concept.synonyms.find((s) => said.includes(` ${words(s).join(' ')} `))
    if (!synonym) continue
    concepts.push({ concept, synonym })
    // The rank-independent channel: a fired concept brings its relation along and names its column.
    let e = entities.find((x) => x.relation.name === concept.relation)
    const relation = docs.relations.find((r) => r.name === concept.relation)
    if (!e && relation) entities.push((e = { relation, rank: entities.length + 1, score: 0, mode: 'compact', named: new Set() }))
    e?.named.add(concept.column)
  }
  return { question, entities, concepts }
}

const PREAMBLE = `You answer a question about Acme Analytics by writing one PostgreSQL SELECT.
Rules:
1. Read only the relations and columns listed below. Nothing else exists.
2. One statement. No writes, no DDL. Functions: count, sum, avg, min, max, round, coalesce, lower, date_trunc, nullif, rank, row_number.
3. Today is 2025-12-31. Write dates as literals.
4. If part of the question needs data that is not listed, answer the rest and name the missing part in "gaps".
5. Alias output columns with plain names. Do not invent thresholds.
Reply as JSON: {"sql": "...", "assumptions": ["..."], "gaps": ["..."]}`

const col = (c: Column, full: boolean) =>
  full ? `- ${c.name} (${c.type}): ${c.description}${c.limitation ? ` Limitation: ${c.limitation}` : ''}` : `- ${c.name} (${c.type})`

export function render(b: Bundle): string {
  const rel = (e: Entity) =>
    e.mode === 'whole'
      ? [`### ${e.relation.name}`, e.relation.description, `Grain: ${e.relation.grain}`, ...e.relation.columns.map((c) => col(c, e.named.has(c.name)))].join('\n')
      : [`### ${e.relation.name} (compact)`, `Grain: ${e.relation.grain}`, `Columns: ${e.relation.columns.map((c) => `${c.name} (${c.type})`).join(', ')}`].join('\n')
  return [
    PREAMBLE,
    '## Relations',
    ...b.entities.map(rel),
    ...(b.concepts.length ? ['## Concepts', ...b.concepts.map(({ concept: c }) => `- ${c.name} (${c.relation}.${c.column}): ${c.rule}`)] : []),
    `## Question\n${b.question}`,
  ].join('\n\n')
}

export type Trace = { where: string; channel: string; reached: boolean; why: string }

/** Where a rule is written, and whether (and why) it reached the prompt for this question. */
export function trace(question: string, docs: Docs, rule: string): Trace[] {
  const b = retrieve(question, docs)
  const prompt = render(b)
  const out: Trace[] = []
  const at = (rel: string) => b.entities.find((e) => e.relation.name === rel)
  const placed = (where: string, rel: string, column?: string): Trace => {
    const e = at(rel)
    const reached = prompt.includes(rule)
    if (!e) return { where, channel: '-', reached, why: `${rel} was not retrieved for this question` }
    if (e.mode === 'compact') return { where, channel: 'c', reached, why: `${rel} ranked ${e.rank}, rendered compact: descriptions dropped` }
    if (column && !e.named.has(column)) return { where, channel: 'b', reached, why: `column ${column} is brief (the question does not name it): description dropped` }
    return { where, channel: column ? 'column' : 'description', reached, why: `${rel} ranked ${e.rank}, rendered whole` }
  }
  for (const r of docs.relations) {
    if (r.prose.some((p) => p.includes(rule))) out.push({ where: `${r.name}: prose section`, channel: 'a', reached: false, why: 'prose sections are never rendered' })
    if (r.description.includes(rule)) out.push(placed(`${r.name}: description`, r.name))
    for (const c of r.columns)
      if (`${c.description} ${c.limitation}`.includes(rule)) out.push(placed(`${r.name}.${c.name}: column description`, r.name, c.name))
  }
  for (const c of docs.concepts) {
    if (!c.rule.includes(rule)) continue
    const f = b.concepts.find((x) => x.concept === c)
    out.push(f
      ? { where: `concept ${c.name}`, channel: 'd', reached: true, why: `fired on synonym "${f.synonym}"` }
      : { where: `concept ${c.name}`, channel: 'd', reached: false, why: `no synonym in the question (synonyms: ${c.synonyms.join(', ')})` })
  }
  return out
}

/** The ceiling test/prompt.test.ts holds the corpus median under. Raise deliberately, never to make a doc change pass. */
export const PROMPT_CEILING_BYTES = 1_900

export function medianPromptBytes(docs: Docs, questions: string[]): number {
  const s = questions.map((q) => Buffer.byteLength(render(retrieve(q, docs)))).sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}

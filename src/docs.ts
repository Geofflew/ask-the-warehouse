/**
 * The semantic docs: one markdown file per relation plus concepts.md. A relation doc is a title, a
 * description, a "Grain:" line, a column table, and optionally `## ...` prose sections after the
 * table. The documented columns are also the exposure allowlist: undocumented means unreadable.
 */
import { readdirSync, readFileSync } from 'node:fs'

export type Column = { name: string; type: string; description: string; limitation: string }
export type Relation = { name: string; description: string; grain: string; columns: Column[]; prose: string[] }
export type Concept = { name: string; relation: string; column: string; synonyms: string[]; rule: string }
export type Docs = { relations: Relation[]; concepts: Concept[] }

export const DOCS_DIR = new URL('../semantic/', import.meta.url)

export function parseRelation(md: string): Relation {
  const [head, ...sections] = md.split(/^## /m)
  const lines = head!.split('\n')
  const name = lines.find((l) => l.startsWith('# '))!.slice(2).trim()
  const grain = lines.find((l) => l.startsWith('Grain:'))?.slice(6).trim() ?? ''
  const description = lines.filter((l) => l && !/^(# |Grain:|\|)/.test(l)).join(' ').trim()
  const columns = lines
    .filter((l) => l.startsWith('|') && !/^\|\s*(column|-)/.test(l))
    .map((l) => {
      const [n, type, description, limitation] = l.split('|').slice(1, -1).map((c) => c.trim())
      return { name: n!, type: type!, description: description ?? '', limitation: limitation ?? '' }
    })
  return { name, description, grain, columns, prose: sections.map((s) => `## ${s.trim()}`) }
}

export function parseConcepts(md: string): Concept[] {
  return md.split(/^## /m).slice(1).map((block) => {
    const [name, ...rest] = block.trim().split('\n')
    const field = (k: string) => rest.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim() ?? ''
    const [relation, column] = field('column').split('.')
    return {
      name: name!.trim(), relation: relation!, column: column!,
      synonyms: field('synonyms').split(',').map((s) => s.trim()).filter(Boolean),
      rule: rest.filter((l) => l && !/^(column|synonyms):/.test(l)).join(' ').trim(),
    }
  })
}

export function loadDocs(dir: URL = DOCS_DIR): Docs {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
  const read = (f: string) => readFileSync(new URL(f, dir), 'utf8')
  return {
    relations: files.filter((f) => f !== 'concepts.md').map((f) => parseRelation(read(f))),
    concepts: files.includes('concepts.md') ? parseConcepts(read('concepts.md')) : [],
  }
}

/** relation -> documented columns. The policy reads nothing else. */
export function exposure(docs: Docs): Map<string, Set<string>> {
  return new Map(docs.relations.map((r) => [r.name, new Set(r.columns.map((c) => c.name))]))
}

/** Deep copy, so a demo can edit docs without touching the shipped ones. */
export const cloneDocs = (d: Docs): Docs => structuredClone(d)

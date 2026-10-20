/**
 * The eval harness. Each bank question has an oracle query against the raw tables; an answer is
 * scored by comparing its rows, projected onto the oracle's columns, with the oracle's rows as a
 * multiset. Two models are compared with McNemar's exact test, which looks only at the questions
 * where they disagree.
 */
import { readFileSync } from 'node:fs'
import type pg from 'pg'
import { parse } from 'yaml'
import { ask, type Outcome } from './ask.ts'
import type { Docs } from './docs.ts'
import type { Model } from './model.ts'

export type Score = 'answered' | 'answered_in_part' | 'unsupported' | 'wrong'
export type Case = { id: string; question: string; oracle?: string; expect?: Score }
export type Run = { id: string; score: Score; pass: boolean }

export const BANK = new URL('../eval/bank.yml', import.meta.url)
export const loadBank = (url: URL = BANK): Case[] => parse(readFileSync(url, 'utf8'))

const norm = (v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v ?? null)
const key = (row: unknown[]) => JSON.stringify(row.map(norm))

export async function score(db: pg.Pool, c: Case, o: Outcome): Promise<Score> {
  if (!o.result) return 'unsupported'
  if (!c.oracle) return 'wrong' // rows came back where the bank says none should
  const truth = await db.query({ text: c.oracle, rowMode: 'array' })
  const want = truth.fields.map((f) => f.name)
  const at = want.map((w) => o.result!.columns.indexOf(w))
  if (at.includes(-1)) return 'wrong'
  const got = o.result.rows.map((r) => key(at.map((i) => r[i]))).sort()
  const exp = (truth.rows as unknown[][]).map(key).sort()
  const same = got.length === exp.length && got.every((g, i) => g === exp[i])
  return !same ? 'wrong' : o.status === 'answered_in_part' ? 'answered_in_part' : 'answered'
}

export async function runBank(db: pg.Pool, bank: Case[], model: Model, docs?: Docs): Promise<Run[]> {
  const runs: Run[] = []
  for (const c of bank) {
    const s = await score(db, c, await ask(db, c.question, model, { docs, log: false }))
    runs.push({ id: c.id, score: s, pass: s === (c.expect ?? 'answered') })
  }
  return runs
}

/** McNemar's exact test on paired pass/fail: b = only A passed, c = only B passed. */
export function mcnemar(a: boolean[], b: boolean[]): { onlyA: number; onlyB: number; p: number } {
  const onlyA = a.filter((x, i) => x && !b[i]).length
  const onlyB = a.filter((x, i) => !x && b[i]).length
  const n = onlyA + onlyB
  let tail = 0
  for (let k = 0; k <= Math.min(onlyA, onlyB); k++) tail += choose(n, k) / 2 ** n
  return { onlyA, onlyB, p: n === 0 ? 1 : Math.min(1, 2 * tail) }
}
const choose = (n: number, k: number): number => (k === 0 ? 1 : (choose(n, k - 1) * (n - k + 1)) / k)

// The prompt byte ceiling. Renders the planner prompt for every question in the bank and holds the
// median under PROMPT_CEILING_BYTES. No database needed.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cloneDocs, loadDocs, parseRelation } from '../src/docs.ts'
import { loadBank } from '../src/eval.ts'
import { medianPromptBytes, PROMPT_CEILING_BYTES } from '../src/retrieve.ts'

const questions = loadBank().map((c) => c.question)
const withDraft = (name: string) => {
  const docs = cloneDocs(loadDocs())
  docs.relations.push(parseRelation(readFileSync(new URL(`../semantic/drafts/invoices-${name}.md`, import.meta.url), 'utf8')))
  return docs
}

describe('6. prompt byte ceiling', () => {
  it('holds the median planner prompt under the ceiling', () => {
    // Raise PROMPT_CEILING_BYTES deliberately, never to make a doc change pass.
    expect(medianPromptBytes(loadDocs(), questions), 'raise deliberately, never to make a doc change pass').toBeLessThan(PROMPT_CEILING_BYTES)
  })
  it('would fail on a relation whose prose uses common question words, and pass once it is trimmed', () => {
    expect(medianPromptBytes(withDraft('leaky'), questions)).toBeGreaterThan(PROMPT_CEILING_BYTES)
    expect(medianPromptBytes(withDraft('trimmed'), questions)).toBeLessThan(PROMPT_CEILING_BYTES)
  })
})

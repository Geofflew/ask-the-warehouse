import { describe, expect, it } from 'vitest'
import { check } from '../src/policy.ts'

// Deliberately omit a column that the database view still contains. These checks run without a DB.
const exposed = new Map([['accounts', new Set(['account_id', 'name', 'region'])]])

describe('output aliases do not grant access to input columns', () => {
  it('refuses a GROUP BY input hidden by an identically named output alias', () => {
    expect(check('SELECT count(*) AS account_owner FROM accounts GROUP BY account_owner', exposed))
      .toMatchObject({ ok: false, rule: 'column_not_exposed', detail: 'account_owner' })
  })

  it('refuses an undocumented input inside an ORDER BY expression', () => {
    expect(check('SELECT 1 AS account_owner FROM accounts ORDER BY lower(account_owner)', exposed))
      .toMatchObject({ ok: false, rule: 'column_not_exposed', detail: 'account_owner' })
  })

  it('allows a bare ORDER BY output alias while recording its documented input', () => {
    expect(check('SELECT name AS account_owner FROM accounts ORDER BY account_owner', exposed))
      .toMatchObject({ ok: true, columns: ['accounts.name'] })
  })

  it('allows documented grouping expressions and ordinal grouping', () => {
    expect(check('SELECT lower(region) AS area, count(*) AS n FROM accounts GROUP BY lower(region) ORDER BY n', exposed))
      .toMatchObject({ ok: true, columns: ['accounts.region'] })
    expect(check('SELECT lower(region) AS area, count(*) AS n FROM accounts GROUP BY 1 ORDER BY n', exposed))
      .toMatchObject({ ok: true, columns: ['accounts.region'] })
  })

  it('conservatively refuses GROUP BY output aliases absent from the documented inputs', () => {
    expect(check('SELECT lower(region) AS area, count(*) AS n FROM accounts GROUP BY area', exposed))
      .toMatchObject({ ok: false, rule: 'column_not_exposed', detail: 'area' })
  })
})

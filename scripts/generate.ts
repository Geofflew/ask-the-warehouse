/**
 * Synthetic "Acme Analytics": 250 accounts, their deals, contracts, tickets and daily usage.
 * Seeded and anchored to AS_OF, so every run writes the same rows. The traps:
 *  - accounts 101-108 signed in 2024 and churned; 109-130 churned too, and several of them won a
 *    renewal in 2024. "Any closed-won deal in 2024" therefore over-counts the 2024 signings.
 *  - Forecasting is sold under the SKU name Horizon (deals.products). Deal notes mention
 *    "forecasting" on deals that never bought it, so a text match on notes is wrong.
 *  - accounts.owner_name for a prospect is the first-touch SDR; the person who owns the prospect
 *    is the open deal's AE. Only accounts.account_owner gets both right.
 *  - 100 active customers x 40 days of usage = a 4,000-row answer.
 */
import type pg from 'pg'
import { AS_OF, connect, setup } from '../src/db.ts'

const SEED = 20251231

function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const day = (iso: string, plus = 0) => new Date(Date.parse(`${iso}T00:00:00Z`) + plus * 86_400_000).toISOString().slice(0, 10)
const addYears = (iso: string, n: number) => `${Number(iso.slice(0, 4)) + n}${iso.slice(4)}`

export async function generate(db: pg.Pool): Promise<void> {
  const r = rng(SEED)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))
  await setup(db)

  const first = ['Avery', 'Blake', 'Casey', 'Drew', 'Emery', 'Finley', 'Harper', 'Jordan', 'Kendall', 'Logan', 'Morgan', 'Quinn']
  const last = ['Ashdown', 'Brightwater', 'Coldridge', 'Dunmore', 'Fairholt', 'Greyling', 'Hollis', 'Kestrel', 'Larkspur', 'Marlow', 'Northcott', 'Pellham']
  const roles = ['csm', 'csm', 'csm', 'csm', 'ae', 'ae', 'ae', 'ae', 'ae', 'sdr', 'sdr', 'sdr'] as const
  const staff = roles.map((role, i) => ({ id: i + 1, role, name: `${first[i]} ${last[(i * 5) % 12]}` }))
  const ids = (role: string) => staff.filter((s) => s.role === role).map((s) => s.id)
  const [csms, aes, sdrs] = [ids('csm'), ids('ae'), ids('sdr')]

  const adj = ['Brisk', 'Copper', 'Quiet', 'Lumen', 'Tidal', 'Granite', 'Amber', 'Nimble', 'Polar', 'Sable', 'Verdant', 'Harbor', 'Juniper', 'Cobalt', 'Saffron', 'Willow', 'Ember', 'Summit']
  const noun = ['Harbor', 'Forge', 'Signal', 'Orchard', 'Beacon', 'Ledger', 'Canyon', 'Meadow', 'Atlas', 'Lattice', 'Ridge', 'Current', 'Prairie', 'Vector']
  const suffix = ['Labs', 'Systems', 'Works', 'Group', 'Co', 'Partners']
  const names = new Set<string>()
  while (names.size < 250) names.add(`${pick(adj)} ${pick(noun)} ${pick(suffix)}`)

  const accounts: unknown[][] = [], deals: unknown[][] = [], contracts: unknown[][] = []
  const tickets: unknown[][] = [], usage: unknown[][] = []
  const notesPool = ['Budget approved in Q1', 'Security review done', 'Champion moved teams', 'Asked about forecasting, not in scope this year',
    'Compared us with a forecasting spreadsheet', 'Wants SSO before rollout', 'Procurement slow', null, null, null]
  let dealId = 0
  const addDeal = (acct: number, name: string, kind: string, stage: string, created: string, closed: string | null, products: string) => {
    const amount = int(8, 60) * 1000
    deals.push([++dealId, acct, `${name} ${kind}`, kind, stage, amount, created, closed, pick(aes), products, pick(notesPool)])
    if (stage === 'closed_won') contracts.push([dealId, acct, dealId, closed, day(addYears(closed!, 1), -1), amount])
  }

  ;[...names].forEach((name, i) => {
    const id = i + 1
    const region = pick(['NA', 'NA', 'EMEA', 'EMEA', 'APAC', 'LATAM'])
    const status = id <= 100 ? 'customer' : id <= 130 ? 'churned' : 'prospect'
    let since: string | null = null, churned: string | null = null
    if (status === 'customer') since = day('2021-01-04', int(0, 1730))
    if (status === 'churned') {
      since = id <= 108 ? day('2024-01-05', int(0, 330)) : day('2021-02-01', int(0, 1000))
      churned = day(id <= 108 ? addYears(since, 1) : since, int(id <= 108 ? 0 : 400, id <= 108 ? 60 : 1200))
      if (churned > AS_OF) churned = day(AS_OF, -int(5, 60))
    }
    const owner = status === 'prospect' ? pick(sdrs) : pick(csms)
    accounts.push([id, name, status, region, status === 'prospect' ? null : pick(['starter', 'growth', 'enterprise']), since, churned, owner])

    if (since) {
      const products = ['Dashboards', ...(r() < 0.5 ? ['Alerts'] : []), ...(r() < 0.3 ? ['Horizon'] : [])].join(', ')
      addDeal(id, name, 'new', 'closed_won', day(since, -40), since, products)
      for (let y = 1; addYears(since, y) <= (churned ?? AS_OF); y++) addDeal(id, name, 'renewal', 'closed_won', day(addYears(since, y), -50), day(addYears(since, y), -10), products)
      if (status === 'customer' && r() < 0.25) {
        const won = day('2025-01-10', int(0, 340))
        addDeal(id, name, 'expansion', 'closed_won', day(won, -30), won, r() < 0.5 ? 'Horizon' : 'Alerts')
      }
    } else {
      if (r() < 0.4) addDeal(id, name, 'new', 'closed_lost', day('2024-02-01', int(0, 200)), day('2024-09-01', int(0, 90)), 'Dashboards')
      addDeal(id, name, 'new', 'open', day('2025-06-01', int(0, 200)), null, pick(['Dashboards', 'Dashboards, Alerts', 'Dashboards, Horizon']))
    }

    if (status === 'customer') {
      for (let t = int(0, 8); t > 0; t--) {
        const opened = day('2025-01-02', int(0, 362))
        tickets.push([0, id, opened, pick(['low', 'normal', 'normal', 'high', 'urgent']), opened > '2025-12-01' || r() < 0.08 ? 'open' : 'closed',
          pick(['Dashboard slow to load', 'Alert fired twice', 'SSO login loop', 'Export missing rows', 'Billing question'])])
      }
      const base = int(3, 60)
      for (let d = 89; d >= 0; d--) {
        const users = Math.max(1, Math.round(base * (0.8 + 0.4 * r())))
        usage.push([id, day(AS_OF, -d), users, users * int(5, 40)])
      }
    }
  })
  tickets.forEach((t, i) => (t[0] = i + 1))

  const insert = async (table: string, rows: unknown[][]) => {
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000), w = chunk[0]!.length
      await db.query(`INSERT INTO raw.${table} VALUES ${chunk.map((_, j) => `(${chunk[0]!.map((__, k) => `$${j * w + k + 1}`).join(',')})`).join(',')}`, chunk.flat())
    }
  }
  await insert('staff', staff.map((s) => [s.id, s.name, s.role, `${s.name.toLowerCase().replace(' ', '.')}@acme.example`, pick(['B2', 'B3', 'B4'])]))
  await insert('accounts', accounts)
  await insert('deals', deals)
  await insert('contracts', contracts)
  await insert('support_tickets', tickets)
  await insert('product_usage', usage)
  await insert('loads', ['staff', 'accounts', 'deals', 'contracts', 'support_tickets', 'product_usage'].map((t) => [t, `${AS_OF}T06:00:00Z`]))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = connect()
  await generate(db)
  const { rows } = await db.query(`SELECT (SELECT count(*) FROM raw.accounts) a, (SELECT count(*) FROM raw.deals) d,
    (SELECT count(*) FROM raw.support_tickets) t, (SELECT count(*) FROM raw.product_usage) u`)
  console.log(`generated: ${rows[0].a} accounts, ${rows[0].d} deals, ${rows[0].t} tickets, ${rows[0].u} usage rows (seed ${SEED}, as of ${AS_OF})`)
  await db.end()
}

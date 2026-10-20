/**
 * The model, scripted. A planner is a function from (question, rendered prompt) to SQL; this repo is
 * about what happens around that call, so the call itself is a lookup. One twist makes the prompt the
 * variable under test: a step written `{ needs, right, wrong }` returns the right SQL only when the
 * rendered prompt contains `needs` (a rule's text, or the column a fix adds). A rule that never
 * reaches the prompt cannot change the plan, which is the whole point of section 4 of the demo.
 */
export type Plan = { sql?: string; assumptions: string[]; gaps: string[] }
export type Review = { verdict: 'approve' | 'revise'; notes: string[] }
export interface Model {
  name: string
  plan(question: string, prompt: string): Plan
  review(question: string, prompt: string, plan: Plan): Review
  revise(question: string, prompt: string, plan: Plan, notes: string[]): Plan
}

type Step = string | { needs: string; right: string; wrong: string }
export type Entry = { plan: Step; gaps?: string[]; assumptions?: string[]; review?: Review; revise?: string }

export const FORECASTING_RULE = 'Forecasting is sold under the SKU name Horizon'
const forecasting = (match: string) =>
  `SELECT deal_id, deal_name, closed_on, amount FROM deals WHERE stage = 'closed_won' AND closed_on >= '2025-01-01' AND closed_on < '2026-01-01' AND ${match} ORDER BY closed_on, deal_id`
const ownerOf = (column: string) => `SELECT name AS account, ${column === 'account_owner' ? column : `${column} AS account_owner`} FROM accounts WHERE status = 'prospect' ORDER BY name`
const tickets = (join: string, filter: string) =>
  `SELECT a.name AS account, count(t.ticket_id) AS tickets FROM accounts a ${join} support_tickets t ON t.account_id = a.account_id${filter} GROUP BY a.name ORDER BY a.name`
const topUsage = (measure: string) =>
  `SELECT a.name AS account, sum(u.${measure}) AS events FROM product_usage u JOIN accounts a ON a.account_id = u.account_id WHERE u.day > '2025-12-01' GROUP BY a.name ORDER BY events DESC LIMIT 10`
const openAmount = (where: string) => `SELECT owner_name, sum(amount) AS open_amount FROM deals${where} GROUP BY owner_name ORDER BY owner_name`

export const SCRIPT: Record<string, Entry> = {
  'Which urgent support tickets are still open?': {
    plan: "SELECT ticket_id, account_id, opened_on, subject FROM support_tickets WHERE priority = 'urgent' AND status = 'open' ORDER BY opened_on, ticket_id",
  },
  'How many active customers are in each region?': {
    plan: "SELECT region, count(*) AS customers FROM accounts WHERE status = 'customer' GROUP BY region ORDER BY region",
  },
  'List the forecasting deals won in 2025.': {
    plan: { needs: FORECASTING_RULE, right: forecasting("products ILIKE '%Horizon%'"), wrong: forecasting("(deal_name ILIKE '%forecast%' OR notes ILIKE '%forecast%')") },
  },
  'How many customers signed in 2024 and churned?': {
    plan: "SELECT count(DISTINCT a.account_id) AS customers FROM accounts a JOIN deals d ON d.account_id = a.account_id WHERE a.status = 'churned' AND d.stage = 'closed_won' AND d.closed_on >= '2024-01-01' AND d.closed_on < '2025-01-01'",
    assumptions: ['"signed in 2024" read as a closed-won deal in 2024'],
    review: { verdict: 'approve', notes: ['"Signed in 2024" is the first signing, which customer_since records; a renewal won in 2024 is not a signing.'] },
    revise: "SELECT count(*) AS customers FROM accounts WHERE status = 'churned' AND customer_since >= '2024-01-01' AND customer_since < '2025-01-01'",
  },
  'Who is the account owner for each prospect?': {
    plan: { needs: 'account_owner (text)', right: ownerOf('account_owner'), wrong: ownerOf('owner_name') },
  },
  'Show daily active users and events for every customer over the last 40 days.': {
    plan: "SELECT u.account_id, a.name AS account, a.region, a.plan, u.day, u.active_users, u.events FROM product_usage u JOIN accounts a ON a.account_id = u.account_id WHERE u.day > '2025-11-21' ORDER BY a.name, u.day",
  },
  "What is each staff member's compensation band?": { plan: 'SELECT name, comp_band FROM raw.staff ORDER BY name' },
  'Delete the closed support tickets.': { plan: "DELETE FROM support_tickets WHERE status = 'closed'" },
  'List active customers in EMEA with their NPS score.': {
    plan: "SELECT name, region FROM accounts WHERE status = 'customer' AND region = 'EMEA' ORDER BY name",
    gaps: ['NPS score: no documented relation records NPS'],
  },
  'What is the total annual contract value of active contracts by region?': {
    plan: "SELECT a.region, sum(c.annual_value) AS annual_value FROM contracts c JOIN accounts a ON a.account_id = c.account_id WHERE c.start_on <= '2025-12-31' AND c.end_on >= '2025-12-31' GROUP BY a.region ORDER BY a.region",
    review: { verdict: 'approve', notes: ['Active is read as start_on <= today <= end_on, which matches a contract term.'] },
  },
  'How many support tickets has each active customer opened in 2025?': {
    // The real mistake a planner makes here: an inner join drops every customer with no tickets.
    plan: tickets('JOIN', " WHERE a.status = 'customer' AND t.opened_on >= '2025-01-01'"),
  },
  'Which 10 customers had the most product events in the last 30 days?': { plan: topUsage('events') },
  'How many active customers does each CSM own?': {
    plan: "SELECT owner_name AS csm, count(*) AS customers FROM accounts WHERE status = 'customer' GROUP BY owner_name ORDER BY owner_name",
  },
  'List churned customers and the day each one churned.': {
    plan: "SELECT name, churned_on FROM accounts WHERE status = 'churned' ORDER BY churned_on, name",
  },
  'What is the total amount of open deals for each deal owner?': { plan: openAmount(" WHERE stage = 'open'") },
  'Rank active customers within each region by annual contract value.': {
    plan: "SELECT a.region, a.name AS account, sum(c.annual_value) AS annual_value, rank() OVER (PARTITION BY a.region ORDER BY sum(c.annual_value) DESC) AS rank_in_region FROM accounts a JOIN contracts c ON c.account_id = a.account_id WHERE a.status = 'customer' AND c.start_on <= '2025-12-31' AND c.end_on >= '2025-12-31' GROUP BY a.region, a.name ORDER BY a.region, rank_in_region",
  },
}

/** A second scripted "model" for the paired comparison: worse on three questions, better on one. */
export const SMALLER: Record<string, Entry> = {
  ...SCRIPT,
  'List the forecasting deals won in 2025.': { plan: forecasting("deal_name ILIKE '%forecast%'") },
  'Which 10 customers had the most product events in the last 30 days?': { plan: topUsage('active_users') },
  'What is the total amount of open deals for each deal owner?': { plan: openAmount('') },
  'How many support tickets has each active customer opened in 2025?': {
    plan: tickets('LEFT JOIN', " AND t.opened_on >= '2025-01-01' WHERE a.status = 'customer'"),
  },
}

export class ScriptedModel implements Model {
  constructor(private readonly script: Record<string, Entry> = SCRIPT, readonly name = 'scripted') {}
  private entry(q: string): Entry | undefined {
    return this.script[q]
  }
  plan(q: string, prompt: string): Plan {
    const e = this.entry(q)
    if (!e) return { assumptions: [], gaps: ['the scripted model has no plan for this question'] }
    const sql = typeof e.plan === 'string' ? e.plan : prompt.includes(e.plan.needs) ? e.plan.right : e.plan.wrong
    return { sql, assumptions: e.assumptions ?? [], gaps: e.gaps ?? [] }
  }
  review(q: string): Review {
    return this.entry(q)?.review ?? { verdict: 'approve', notes: [] }
  }
  revise(q: string, _prompt: string, plan: Plan): Plan {
    const sql = this.entry(q)?.revise
    return sql ? { ...plan, sql, assumptions: [] } : plan
  }
}

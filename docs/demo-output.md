# Full demo output

What `pnpm generate && pnpm demo` prints against an empty Postgres. Two runs are byte-identical.
Section by section notes are in [mechanisms.md](mechanisms.md).

```
Acme Analytics, as of 2025-12-31: 250 accounts, 584 deals. Planner and critic: scripted (no API key, deterministic).

==============================================================================
1. Plan check over the documented schema, and read-only execution
==============================================================================
Q: What is each staff member's compensation band?
   plan: SELECT name, comp_band FROM raw.staff ORDER BY name
BROKEN   run as the app's own connection: 12 rows, e.g. ["Avery Ashdown","B2"]
GUARDED  plan check refused: relation_not_exposed (raw.staff)
         and if the check were skipped, the reader role says: permission denied for schema raw
Q: Delete the closed support tickets.
   plan: DELETE FROM support_tickets WHERE status = 'closed'
BROKEN   run as the app's own connection: 327 tickets deleted (rolled back here so the demo repeats)
GUARDED  plan check refused: select_only (statement type delete)
         and if the check were skipped, the reader role says: permission denied for view support_tickets
DIFF     two independent guards: the parser refuses by rule before anything runs; the role and the read-only
         transaction refuse inside Postgres if a plan ever got past the parser.
SELECT name, pg_sleep(10) FROM accounts
         -> refused: function_not_allowed (pg_sleep)
SELECT * FROM accounts
         -> refused: wildcard_not_allowed (*)
SELECT name FROM accounts WHERE status = 'customer'
         -> passes; runs as: SELECT name  FROM accounts   WHERE (status = ('customer')) LIMIT (10001)
Q: Show daily active users and events for every customer over the last 40 days.  (row cap lowered to 1000 for this run; shipped cap 10000)
BROKEN   LIMIT 1000: 1000 rows back, and nothing in them says whether that is all of it
GUARDED  ran: ...LIMIT (1001); one row past the cap came back, so status answered_in_part, 1000 rows kept
         gap: row_cap: more than 1000 rows matched and only 1000 were fetched; narrow the question for the rest

==============================================================================
2. Risk-routed critic: runs only on joins, aggregates, windows, time boundaries, set operations
==============================================================================
  open_urgent            critic skipped: flat single-table select
  customers_by_region    critic runs: aggregation
  forecasting_won        critic runs: time_boundary
  signed_and_churned     critic runs: join, aggregation, time_boundary, set_operation
  prospect_owner         critic skipped: flat single-table select
  daily_usage            critic runs: join, time_boundary
  emea_nps               critic skipped: flat single-table select
  acv_by_region          critic runs: join, aggregation, time_boundary
  tickets_per_customer   critic runs: join, aggregation, time_boundary
  top_events             critic runs: join, aggregation, time_boundary
  csm_book               critic runs: aggregation
  churned_list           critic skipped: flat single-table select
  open_amount_by_owner   critic runs: aggregation
  rank_by_acv            critic runs: join, aggregation, window, time_boundary
NOTE     the critic ran on 10 of 14 plans that passed the check, not 14. The limit of routing: prospect_owner
         is skipped, and in section 5's broken schema that flat SELECT reads the wrong column. A wrong column carries no structural risk.

==============================================================================
3. Critic notes are corrections
==============================================================================
Q: How many customers signed in 2024 and churned?
   plan: SELECT count(DISTINCT a.account_id) AS customers FROM accounts a JOIN deals d ON d.account_id = a.account_id WHERE a.status = 'churned' AND d.stage = 'closed_won' AND d.closed_on >= '2024-01-01' AND d.closed_on < '2025-01-01'
   critic: approve, note: "Signed in 2024" is the first signing, which customer_since records; a renewal won in 2024 is not a signing.
BROKEN   note shipped as a caveat; the plan ran as written: 19 customers (oracle: 8)
GUARDED  note names accounts.customer_since: a column of a relation in the bundle that no statement reads
         -> promoted to a revision: SELECT count(*) AS customers FROM accounts WHERE status = 'churned' AND customer_since >= '2024-01-01' AND customer_since < '2025-01-01'
         -> 8 customers (oracle: 8)
NOTE     acv_by_region's note names start_on and end_on, which the plan reads: it stays a caveat (approved_with_notes).

==============================================================================
4. The four retrieval channels: where a rule is written decides whether the planner sees it
==============================================================================
Q: List the forecasting deals won in 2025.   (oracle: 41 deals; c uses: "Which regions, owners, open tickets and active users do customers with forecasting products have?")
BROKEN   (a) prose section under the table    dark     prose sections are never rendered -> 22 rows, 7 right
BROKEN   (b) products column description      dark     column products is brief (the question does not name it): description dropped -> 22 rows, 7 right
BROKEN   (c) same column, other question      dark     deals ranked 4, rendered compact: descriptions dropped
BROKEN   (d) concept, customer synonyms       dark     no synonym in the question (synonyms: forecasting customer, on forecasting) -> 22 rows, 7 right
GUARDED  (d) concept + "forecasting deal"     reached  fired on synonym "forecasting deal" -> 41 rows, 41 right
DIFF     same rule text, same scripted planner; only where the rule is written changed. The wrong plan matches
         "forecast" in deal names and notes, which mention products discussed, not bought.

==============================================================================
5. A two-table rule becomes one column
==============================================================================
Q: Who is the account owner for each prospect?
BROKEN   schema: no account_owner column; the rule is a concept (fired on synonym "account owner").
         plan: SELECT name AS account, owner_name AS account_owner FROM accounts WHERE status = 'prospect' ORDER BY name
         status answered, critic skipped: 0 of 120 owners right (it read the first-touch SDR)
GUARDED  schema: accounts.account_owner does the branch in the view.
         plan: SELECT name AS account, account_owner FROM accounts WHERE status = 'prospect' ORDER BY name
         status answered: 120 of 120 owners right
DIFF     same scripted planner in both runs. It returns the right plan only when the prompt lists account_owner,
         and is written to miss the two-table rule. What changed is the schema: one column, no rule.

==============================================================================
6. Prompt byte ceiling as a test
==============================================================================
  shipped docs                             median   1753 bytes under 1900   invoices in 0 of 16 bundles
  + invoices, leaky description (BROKEN)   median 2071.5 bytes OVER  1900   invoices in 15 of 16 bundles
  + invoices, renamed + trimmed            median 1867.5 bytes under 1900   invoices in 6 of 16 bundles
NOTE     none of these questions is about invoices. The leaky draft says "total", "deal", "customer" and names a
         column `total`, and descriptions and column names are scored and rendered. test/prompt.test.ts fails on the leaky draft.

==============================================================================
7. 48KB answer budget
==============================================================================
Q: Show daily active users and events for every customer over the last 40 days.  (4000 rows)
BROKEN   rows as objects, 500 a page: 8 pages of ~66.2KB each, 533.6KB into the client's context
GUARDED  one answer of 48.0KB: 735 of 4000 rows inline, columns once, rows as arrays
         hint: 3265 more rows are in the download. Narrow the question (one account, one region, a shorter date range) instead of asking for the next page.
         download: out/answers/4b3d1cde.csv
answer log:
   1 How many customers signed in 2024 and churne answered           1047 B     1/1    rows  critic approved_with_notes
   2 How many customers signed in 2024 and churne answered            601 B     1/1    rows  critic revised
   3 Who is the account owner for each prospect?  answered           5375 B   120/120  rows  critic skipped
   4 Who is the account owner for each prospect?  answered           5501 B   120/120  rows  critic skipped
   5 Show daily active users and events for every answered          47988 B   735/4000 rows  critic approved
bytes by part over the bank's 14 answers: rows 87%, freshness 2%, warnings 0%, sql 7%, assumptions 0%, columns 1%, question 1%, keys, status, counts, hint 3%
the same over the 7 answers of 20 rows or fewer: rows 24%, freshness 10%, warnings 2%, sql 36%, assumptions 0%, columns 3%, question 7%, keys, status, counts, hint 18%

==============================================================================
8. Eval harness: question bank with SQL oracles, paired comparison
==============================================================================
  question               scripted           scripted-small
  open_urgent            answered           answered
  customers_by_region    answered           answered
  forecasting_won        answered           wrong x
  signed_and_churned     answered           answered
  prospect_owner         answered           answered
  daily_usage            answered           answered
  staff_comp             unsupported        unsupported
  delete_tickets         unsupported        unsupported
  emea_nps               answered_in_part   answered_in_part
  acv_by_region          answered           answered
  tickets_per_customer   wrong x            answered
  top_events             answered           wrong x
  csm_book               answered           answered
  churned_list           answered           answered
  open_amount_by_owner   answered           wrong x
  rank_by_acv            answered           answered
  total                  15/16 pass         13/16 pass
NOTE     McNemar exact: only scripted passed 3, only scripted-small passed 1, p = 0.625.
         2 more passes is not evidence of a difference on a bank this size; the 12 questions
         where the two agree carry no information about which is better.
```

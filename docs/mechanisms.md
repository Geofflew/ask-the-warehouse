# Mechanisms, in full

One section per mechanism: how it works, what was rejected, and what its demo section prints. The README
groups these mechanisms into three concepts; the full demo output is in [demo-output.md](demo-output.md). Section
numbers match the demo.

## The model is scripted

`src/model.ts:ScriptedModel` is a lookup by question. For the questions that show a rule reaching
the planner, a step is `{ needs, right, wrong }`: the right SQL comes back only if the rendered
prompt contains `needs` (the rule's text, or the line `account_owner (text)`). That is the honest
choice for a repo about the plumbing around a model. A live model would make the demo
nondeterministic and would test the model; the scripted one makes the prompt the only variable, so
when section 4 says a rule "reached", the plan changed because of the prompt and nothing else.
The scripted planner's mistakes are written by hand to exercise the guards. The demo does not
measure whether or how often a live model makes these mistakes. No live model is wired in; `Model` is a three-method interface.

## 1. Plan check and read-only execution

`src/policy.ts:check` parses the SQL with `pgsql-ast-parser` and walks every node of the tree.
One statement; no insert, update, delete or DDL node anywhere (which also catches a data-modifying
CTE); every relation documented, in schema `semantic` or unqualified; every column a documented
column of a relation in the query, or, where SQL allows it, a CTE column in that SELECT's FROM or an
output alias standing alone in ORDER BY. Inside an ORDER BY expression, names are inputs.
GROUP BY also prefers an input when names collide, so output aliases absent from the documented
inputs are conservatively refused: repeat the input expression or use its ordinal. An alias
elsewhere (`SELECT x AS x`) reads a real column and is checked as one; every function on a twelve-name
list (EXISTS is refused under its own rule). The allowlist is the docs: `src/docs.ts:exposure`
reads the column tables, so a column nobody documented cannot be read. A test checks that each
doc lists exactly its view's columns.

A wildcard is refused as `wildcard_not_allowed`: `SELECT *`, `a.*`, and a `*` inside a subquery or
over a CTE. Without that rule a column taken out of the docs is refused when named and returned
anyway by `SELECT *`, because the role can still read the view. Refusing beats expanding: the
planner writes the SQL, so it can name the columns it wants, and expanding a `*` against the
allowlist would need the database catalog at check time, which the check otherwise never reads.
`count(*)` is a call argument, not a column read, and passes. A test removes `account_owner` from
the docs and shows both `SELECT account_owner` and `SELECT *` refused.

The row cap. If the plan has no LIMIT, or one above `MAX_ROWS` (10,000), the check sets the LIMIT
to `MAX_ROWS + 1`. `src/ask.ts:ask` then counts the rows: if more than `MAX_ROWS` came back, it
drops the extra one, sets the status to `answered_in_part`, and adds a gap naming the cap. A plan
whose own LIMIT is at or under the cap is left alone. The answer's `sql` is the SQL that ran, LIMIT
included; `planned_sql` carries what the planner wrote whenever the service changed it. Without
this, a query matching more rows than the cap came back cut, with status `answered` and the
planner's SQL, so nothing in the answer showed rows were missing; and the 48KB download (section
7) cannot recover rows the SQL never fetched.

`src/execute.ts:runReadOnly` then runs the checked SQL in `BEGIN READ ONLY`, with a statement
timeout, as `acme_ask_reader`, a NOLOGIN role with SELECT on the semantic views and nothing else.
The tests skip the parser and show Postgres refusing a raw-table read, a write and a long sleep.

Rejected: matching SQL text with patterns. A pattern sees `raw.` but not a subquery behind an
alias, and a CTE that deletes looks like a SELECT at the front. Also rejected: trusting the role
alone. It stops the damage but returns a Postgres error, not a rule the planner can be told about.

**In the demo.** The planner is asked for each staff member's
compensation band and writes `SELECT name, comp_band FROM raw.staff`. Run as the app's own
connection it returns 12 rows of pay bands. The plan check refuses it as `relation_not_exposed
(raw.staff)`, and if the check were skipped the execution role says `permission denied for schema
raw`. A `DELETE` of closed tickets would remove 327 rows on the app connection (rolled back in the
demo); the check refuses it as `select_only`. `pg_sleep` is refused as `function_not_allowed`,
`SELECT * FROM accounts` as `wildcard_not_allowed`. Then the row cap, lowered to 1,000 for the run
on the 4,000-row usage question: a plain `LIMIT 1000` returns 1,000 rows and nothing says whether
that is all; the guarded run executes `LIMIT 1001`, gets the extra row, keeps 1,000 and answers
`answered_in_part` with the gap `row_cap: more than 1000 rows matched and only 1000 were fetched`.
Notice that the refusals name a rule, and that there are two guards that do not trust each other.

## 2. Risk-routed critic

The same walk returns the plan's structural risks: a join (two relations anywhere in the query, subqueries included), an aggregate or GROUP BY, a window,
a time boundary (a date literal, `current_date`, `extract`, `date_trunc`) or a set operation
(UNION or DISTINCT). `src/ask.ts:ask` calls the critic only when that list is non-empty and records
which risks fired. Rejected: a critic on every request, which would add a model call even to a simple query.
This scripted demo does not measure model cost or caching. Its blind spot is stated in the
demo and in the limits: a wrong column for an ambiguous term arrives as a flat SELECT.

**In the demo.** For each bank plan, either `critic runs: join, aggregation, ...` or
`critic skipped: flat single-table select`. It runs on 10 of 14 plans. Notice the limit printed
under it: the account-owner question is a flat SELECT, so the critic never sees the wrong-column
bug section 5 is about.

## 3. Critic notes are corrections

`src/ask.ts:overlookedColumns` takes the critic's notes, the bundle and the columns the plan reads
(from the AST, not from text). Any snake_case word in a note that is a real column of a relation in
the bundle, and that no statement reads, promotes "approve with notes" to a revision. Nothing about
the note's wording is judged; the proof is a set lookup. A plan is revised at most once
whether the critic asked for it or a note was promoted, so the most a question can cost does not
change. Rejected: shipping notes as
caveats, which is how the reviewer found the bug and the bug shipped anyway.

**In the demo.** "How many customers signed in 2024 and churned?" The plan
counts churned accounts with any closed-won deal in 2024, renewals included. The critic approves
with a note saying the signing date is `customer_since`. (The scripted reviser returns its canned
fix; it does not read the note.)

```
BROKEN   note shipped as a caveat; the plan ran as written: 19 customers (oracle: 8)
GUARDED  note names accounts.customer_since: a column of a relation in the bundle that no statement reads
         -> promoted to a revision ... -> 8 customers (oracle: 8)
```

A second note, on the contract-value question, names `start_on` and `end_on`, which that plan
already reads, so it stays a caveat.

## 4. The four retrieval channels

`src/retrieve.ts:retrieve` scores each relation against the question's words, weighted by rarity
across relations, with name matches worth most, then description and grain, column names, then
column descriptions and limitations. Prose sections are not scored and not rendered. The top 3
render whole, ranks 4 to 6 compact. Inside a whole relation, a column renders with its description
only if every word of its name is in the question. A concept renders whenever one of its synonyms
appears as a phrase in the question, brings its relation into the bundle, and un-briefs its
column. `src/retrieve.ts:trace(question, docs, rule)` finds where a rule is written and reports the
channel and why it did or did not reach the prompt; a test checks that its verdict always agrees
with a plain `prompt.includes(rule)`.

The non-obvious part is that brief columns and compact relations are deliberate. They are what
keeps the prompt small (section 6), and each one closes a channel. So the place to write a rule is
chosen by the questions it must reach, then checked with `trace`. Rejected: rendering every
description. It makes the prompt grow with the schema and sends every rule to every question.

**In the demo.** One rule ("Forecasting is sold under the SKU name Horizon")
written in five places, for "List the forecasting deals won in 2025." (41 deals in the oracle):

```
BROKEN   (a) prose section under the table    dark     prose sections are never rendered -> 22 rows, 7 right
BROKEN   (b) products column description      dark     column products is brief (the question does not name it) ... -> 22 rows, 7 right
BROKEN   (c) same column, other question      dark     deals ranked 4, rendered compact: descriptions dropped
BROKEN   (d) concept, customer synonyms       dark     no synonym in the question (synonyms: forecasting customer, on forecasting) -> 22 rows, 7 right
GUARDED  (d) concept + "forecasting deal"     reached  fired on synonym "forecasting deal" -> 41 rows, 41 right
```

Notice that the rule text and the planner are identical in every row. The wrong plan matches
"forecast" in deal names and notes, which mention products that were discussed, not bought.

## 5. Two-table rules become columns

`src/schema.sql: semantic.accounts.account_owner` is a CASE in the view: the account record's
owner for a customer, the open deal's owner for a prospect. Rejected: the same rule as a concept.
A planner reads a column reliably and carries out a rule spanning two relations only sometimes,
and when it does not, nothing fails: the answer has the right shape and the wrong person.

**In the demo.** "Who is the account owner for each prospect?" Before:
no `account_owner` column, and a concept says "for a customer read `owner_name`; for a prospect
read the open deal's owner". The plan reads `owner_name`, status `answered`, critic skipped, 0 of
120 owners right (it read the first-touch SDR). The scripted planner is written to miss the
two-table rule; it only looks for the `account_owner` column. After: the view
does the branch and exposes `accounts.account_owner`; 120 of 120. What changed is the schema, not
the model: the demo shows the column fix working, not that the rule is unreliable.

## 6. Prompt byte ceiling as a test

`test/prompt.test.ts` renders the prompt for every bank question and asserts the median is under
`src/retrieve.ts:PROMPT_CEILING_BYTES` (1,900), with the message "raise deliberately, never to make
a doc change pass". A second test proves the first can fail: the leaky invoices draft breaks it and
the trimmed one does not. Rejected: a per-relation size limit. The leaky draft is short; the cost
is that its vocabulary puts it into 15 of 16 unrelated bundles and shifts the median.

**In the demo.** The median planner prompt over the 16 bank questions:

```
shipped docs                             median   1753 bytes under 1900   invoices in 0 of 16 bundles
+ invoices, leaky description (BROKEN)   median 2071.5 bytes OVER  1900   invoices in 15 of 16 bundles
+ invoices, renamed + trimmed            median 1867.5 bytes under 1900   invoices in 6 of 16 bundles
```

None of the questions is about invoices. The leaky draft's description says "total", "deal" and
"customer" and it names a column `total`; descriptions and column names are scored and rendered,
unlike prose sections.

## 7. 48KB answer budget

`src/answer.ts:envelope` serialises the answer with column names once and rows as arrays, and if
it exceeds 48,000 bytes binary-searches the largest number of rows that fits. The rest go to a CSV
file whose path is in the answer, with a hint to narrow the question instead of paging.
`logAnswer` records bytes, rows inline and rows total for every answer. `breakdown` prints each
part's share of bytes. Rejected: paging. A client that pages a large result has spent its context
and still has no answer; a narrower question costs one call.

**In the demo.** Daily usage for every customer over 40 days is 4,000 rows. As objects,
500 a page, it is 8 pages of about 66.2KB, 533.6KB in all. Guarded, it is one 48.0KB answer with
735 rows inline, a hint ("3265 more rows are in the download. Narrow the question ... instead of
asking for the next page."), a CSV path with all 4,000 rows, and a log row with bytes and row
counts. Then the payload breakdown: over the bank's 14 answers rows are 87% of bytes (the big
answer dominates); over the 7 answers of 20 rows or fewer, rows are 24%, the SQL 36% (the SQL that
ran and the planner's, since the service added a LIMIT to each), freshness 10%, the question text
7%, and the envelope's keys, status, counts and hint 18%.

The 48KB budget and the row cap are separate. The budget moves rows the SQL fetched into a
download; the cap decides how many the SQL fetches. Section 1 is where a cut result is marked
partial.

## 8. Eval harness

`eval/bank.yml` holds 16 questions, each with an oracle query against the raw tables (written
without the semantic views) and the outcome that counts as a pass. `src/eval.ts:score` compares an
answer's rows, projected onto the oracle's column names, with the oracle's rows as a multiset, and
scores answered, answered_in_part (rows right and a gap declared), unsupported (refused or no plan)
or wrong. `mcnemar` is the exact two-sided test on the discordant pairs. Rejected: comparing pass
rates. Two models that each pass 13 of 16 can disagree on six questions; only the disagreements
carry information, and on a small bank they rarely reach significance.

**In the demo.** The 16-question bank scored for two scripted planners: 15/16 against 13/16.
Each disagreement is printed. McNemar's exact test: only the first passed 3, only the second passed
1, p = 0.625. Notice the conclusion it prints: two more passes on a bank this size is not evidence,
and the 12 questions where they agree say nothing about which is better.

## Where the traps are in the data

The traps are in `scripts/generate.ts` (seed `20251231`, anchor 2025-12-31): accounts 101 to 108
signed in 2024 and churned, and older churned accounts won renewals in 2024; Forecasting appears in
`deals.products` only as `Horizon`, while deal notes mention forecasting on deals that never bought
it; a prospect's `owner_name` is the first-touch SDR, never the deal owner; 100 customers times 40
days of usage make the 4,000-row answer.

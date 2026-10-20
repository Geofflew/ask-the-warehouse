# Scope and implementation limits

[Back to the overview](../README.md)


- The planner and critic are scripted. The demo proves what the plumbing does with a plan and a
  note, and that a rule reaching the prompt is what the script responds to. It does not prove that
  a real model makes these mistakes or fixes them. `ScriptedModel.revise` ignores the notes.
- Retrieval is lexical with naive stemming. A question that uses none of a relation's words will
  not find it; that is what concepts are for, and a concept with the wrong synonyms is as dark as
  prose. `trace` explains one rule at a time; it does not find which rules are dark for the
  questions people actually ask.
- A wildcard is refused everywhere, including over a CTE whose columns the plan defined itself,
  where it would be safe. The planner must name columns.
- The row cap keeps the first rows the database returned. Without an ORDER BY, which rows those are
  is arbitrary; the gap says the answer is partial, not which part is missing.
- The plan check resolves table aliases across the whole statement, not per scope. An output alias is accepted only as a bare name in its SELECT’s ORDER BY,
  never inside an expression. GROUP BY must use documented input columns, their expressions, or
  ordinals; an output alias alone cannot bypass the column allowlist. CTE columns are checked in
  the SELECT that reads them. Thus `SELECT
  account_owner AS account_owner` cannot read an undocumented column. SQL the parser cannot read is
  refused. `EXISTS (...)` is refused under its own rule.
- `overlookedColumns` considers only snake_case words, and does not read meaning: a negated note
  ("churned_on is not needed here") is still promoted.
- The critic cannot see a wrong column in a flat SELECT, by construction.
- An answer already over 48KB before any rows ships with 0 rows inline and over the cap. The
  download is a local file with no expiry or access control.
- The byte ceiling and the bank are measured over 16 questions. McNemar on that can show a
  difference is not evidence; it will rarely show that one is.
- The read-only role is only as narrow as the views it can read.

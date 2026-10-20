# Mechanism

A person types a question in plain English. A model reads a description of the warehouse and
writes one SQL query. The query runs and the rows come back. The model is the visible part; this
repo is about everything around it, because that is where answers go wrong without anyone seeing.

## The pipeline

1. **Retrieve.** Each relation the model may query has a written doc: a description, a grain
   (what one row is), a table of columns with descriptions and limitations, and sometimes prose
   sections below the table. Separately, concepts map business words ("forecasting deal",
   "account owner") to a column and a rule. Retrieval scores relations against the question's
   words and builds a bundle: the top three rendered whole, the next few compact (name, grain,
   column names and types only), concepts rendered only when one of their synonyms appears in the
   question. Inside a whole relation, a column the question does not name renders brief: name and
   type, no description.
2. **Plan.** The model gets the rendered bundle and the question, and returns SQL plus its
   assumptions and any part of the question it cannot answer.
3. **Check.** The SQL is parsed into a syntax tree and walked. One SELECT only; every relation and
   column must be in the documented set; only a short list of functions; a row LIMIT is imposed.
   A plan that fails names the rule it broke.
4. **Critic, when it is worth it.** A second model reviews the plan, but only when the plan has
   structural risk: a join, an aggregate, a window, a time boundary or a set operation. A flat
   single-table SELECT skips it. The critic can approve, approve with notes, or ask for a
   revision.
5. **Notes are corrections.** A critic that approves "with notes" has sometimes found the bug and
   said so politely. If a note names a real column of a relation already in the bundle, and no
   statement in the plan reads that column, the approval is promoted to a revision. This is proved
   against the column list, not judged.
6. **Execute.** As a role that can read only the documented views, inside a read-only transaction,
   with a statement timeout. The parser is the first guard and the role is the second; neither
   trusts the other.
7. **Answer within a budget.** The answer is capped in bytes. Column names appear once and rows
   are arrays. When rows are left over, the answer says to filter rather than page, and points to
   a file with all of them. Each answer's bytes and row counts are logged.

## What the docs teach, and what never arrives

A rule only changes a plan if it reaches the prompt. Four places a rule can be written, and when
each one is closed:

- (a) A prose section below the column table is never rendered.
- (b) A column description is dropped when the column is brief, which is whenever the question
  does not name the column.
- (c) A relation ranked fourth or lower renders compact, so all its descriptions are dropped.
- (d) A concept renders whatever the rank, but only if one of its synonyms is in the question.

So the place to write a rule is decided by the questions it must reach, and checked by asking the
retriever which channel carried it.

A rule that spans two relations ("for customers read this column; for prospects read the open
deal's owner") is one a planner will sometimes not carry out, even when it reaches the prompt. The
fix is to do the branch in the view and expose one column.

## What keeps the docs honest over time

- Every doc is retrieval text. A new relation whose description uses common question words
  ("total", "deal", "customer") enters bundles for questions that have nothing to do with it. A
  test renders the prompt for every question in a fixed corpus and holds the median under a byte
  ceiling. The ceiling is raised on purpose, never to make a doc change pass.
- A bank of questions with SQL oracles written against the raw tables scores each answer as
  answered, answered in part, unsupported or wrong. Two models are compared on the same questions
  with McNemar's test, which looks only at the questions where they disagree.

## The model in this repo

The model is scripted: a lookup by question, with one twist. For the questions that show a rule
reaching the planner, the script returns the right plan only if the rendered prompt contains the
rule's text (or the column the fix adds). That makes the demo deterministic and makes the prompt,
not the model, the variable under test.

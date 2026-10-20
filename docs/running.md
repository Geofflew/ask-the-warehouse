# Run the example

[Back to the overview](../README.md)


Use Node 22+, pnpm 11, Git, and a dedicated disposable PostgreSQL database. Create the database
first; generators and tests rebuild example schemas. Do not point them at an application database.

```sh
export DATABASE_URL=postgres://user@127.0.0.1:5432/acme_ask   # any Postgres 14+, an empty database
pnpm i && pnpm generate && pnpm demo
pnpm test                                                      # regenerates the data
```

No API key: the planner and critic are scripted (`src/model.ts:ScriptedModel`), so the output is
the same on every run. `pnpm generate` creates a NOLOGIN role, `acme_ask_reader`, so the database
user needs CREATEROLE. Section 4 of the demo is the comparison in the README. Notice that the scripted planner
returns the right SQL only when the rule's text is in the prompt, so "reached" means the plan
changed because of the prompt and nothing else. That is also the limit: the demo proves the
plumbing, not that a real model makes the mistake (see "The model is scripted" in
[docs/mechanisms.md](mechanisms.md#the-model-is-scripted)). Full output of all eight sections:
[docs/demo-output.md](demo-output.md).

The trap is in `scripts/generate.ts` (seed `20251231`): Forecasting appears in `deals.products`
only as `Horizon`, while deal names and notes mention forecasting on deals that never bought it.

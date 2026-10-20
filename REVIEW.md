# Release review

Reviewed October 19, 2026, for publication as a standalone personal repository.

- Clean dependency install from the committed lockfile: passed.
- TypeScript check: passed.
- Tests: 29 passed on Node 22.23.3 and PostgreSQL 16.14.
- Generator and demo: passed. Two demo runs were byte-identical and matched docs/demo-output.md.
- Overview SVG and PNG: visually inspected; each diagram follows one concrete failure and its guard.

The column-policy follow-up covers GROUP BY input precedence and input references inside ORDER BY expressions. Bare ORDER BY output aliases remain supported; unsupported GROUP BY aliases are refused conservatively. Five focused tests pass; running them against the earlier guard produces three failures, including both reproduced bypasses. PostgreSQL execution of both queries was also checked against the synthetic views.

These checks validate the documented examples over synthetic data, not production suitability. The models, where present, are scripted. A short scope note is in the README; implementation limits are in [docs/limits.md](docs/limits.md). See [the validation record](VALIDATION.md) for publication checks and CI status.

## Fresh-history replacement

The owner authorized replacing the GitHub repository with this current snapshot. The replacement starts with one initial commit, without prior Git history.

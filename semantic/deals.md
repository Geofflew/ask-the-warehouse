# deals

Sales opportunities: new business, renewals and expansions, open or closed.

Grain: one row per deal.

| column | type | description | limitations |
|---|---|---|---|
| deal_id | int | The deal's key. | |
| account_id | int | The account the deal is for. | |
| deal_name | text | Free-text name typed by the rep. | |
| kind | text | new, renewal or expansion. | |
| stage | text | open, closed_won or closed_lost. | |
| amount | numeric | Annual value in dollars. | |
| created_on | date | When the deal was opened. | |
| closed_on | date | When the deal was won or lost. | NULL while open. |
| owner_name | text | The rep who owns the deal. | |
| products | text | Comma-separated SKU names sold on the deal. | |
| notes | text | Free-text rep notes. | Mentions products that were discussed, not bought. |

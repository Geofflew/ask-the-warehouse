# support_tickets

Support requests raised by customers.

Grain: one row per ticket.

| column | type | description | limitations |
|---|---|---|---|
| ticket_id | int | The ticket's key. | |
| account_id | int | The account that raised it. | |
| opened_on | date | When it was raised. | |
| priority | text | low, normal, high or urgent. | |
| status | text | open or closed. | |
| subject | text | The ticket's subject line. | |

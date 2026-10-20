# invoices

Billing documents sent by finance, one per billing period.

Grain: one row per invoice.

| column | type | description | limitations |
|---|---|---|---|
| invoice_id | int | The invoice's key. | |
| account_id | int | The account billed. | |
| deal_id | int | The deal billed. | |
| issued_on | date | When the invoice was sent. | |
| invoice_amount | numeric | Amount on the invoice in dollars. | |
| payment_status | text | open, paid or void. | |

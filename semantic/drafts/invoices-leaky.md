# invoices

Every invoice sent to a customer: the total billed for each deal and contract, the customer's
contract value split into billing periods, and what each customer paid. Use it for any total a
customer was billed, billed monthly or annually, per deal or per contract.

Grain: one row per invoice.

| column | type | description | limitations |
|---|---|---|---|
| invoice_id | int | The invoice's key. | |
| account_id | int | The customer billed. | |
| deal_id | int | The deal the invoice bills. | |
| issued_on | date | When the invoice was sent to the customer. | |
| total | numeric | Total billed to the customer on this invoice, the deal's contract value for the period. | |
| status | text | open, paid or void. | An open invoice is not an open deal. |

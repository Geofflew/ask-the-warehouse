# accounts

Every company Acme sells to or has sold to: active customers, churned customers and prospects.

Grain: one row per account.

| column | type | description | limitations |
|---|---|---|---|
| account_id | int | The account's key. | |
| name | text | Company name. | |
| status | text | customer, churned or prospect. | A churned account keeps its history; filter on status, not churned_on. |
| region | text | NA, EMEA, APAC or LATAM. | |
| plan | text | starter, growth or enterprise. | NULL for prospects. |
| customer_since | date | The day the account first became a customer: its first closed-won deal. | NULL for prospects. Renewals and expansions do not move it. |
| churned_on | date | The day a churned customer left. | NULL unless status is churned. |
| owner_name | text | The staff member on the account record. | For a prospect this is the first-touch SDR, not the person working the deal. |
| account_owner | text | Who owns the account: the CSM for a customer, the open deal's owner for a prospect. | |

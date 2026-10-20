# product_usage

Daily activity in the product for each active customer.

Grain: one row per account per day.

| column | type | description | limitations |
|---|---|---|---|
| account_id | int | The account. | |
| day | date | The calendar day (UTC). | Kept for the last 90 days only. |
| active_users | int | People who signed in that day. | |
| events | int | Actions taken in the product that day. | |

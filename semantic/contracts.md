# contracts

Signed contracts, one per closed-won deal, each covering a year.

Grain: one row per contract.

| column | type | description | limitations |
|---|---|---|---|
| contract_id | int | The contract's key. | |
| account_id | int | The account that signed. | |
| start_on | date | First day of the term. | |
| end_on | date | Last day of the term. | |
| annual_value | numeric | Contract value per year in dollars. | |

-- Three schemas. raw: what the sources wrote. semantic: the documented views the planner may read.
-- app: the answer log. Rebuilt from scratch by `pnpm generate`.
DROP SCHEMA IF EXISTS raw, semantic, app CASCADE;
CREATE SCHEMA raw;
CREATE SCHEMA semantic;
CREATE SCHEMA app;

CREATE TABLE raw.staff (
  staff_id int PRIMARY KEY, name text NOT NULL, role text NOT NULL, -- csm | ae | sdr
  email text NOT NULL, comp_band text NOT NULL                       -- never exposed
);
CREATE TABLE raw.accounts (
  account_id int PRIMARY KEY, name text NOT NULL,
  status text NOT NULL,                       -- customer | churned | prospect
  region text NOT NULL, plan text,
  customer_since date, churned_on date,
  owner_staff_id int REFERENCES raw.staff     -- a CSM for customers, the first-touch SDR for prospects
);
CREATE TABLE raw.deals (
  deal_id int PRIMARY KEY, account_id int NOT NULL REFERENCES raw.accounts,
  deal_name text NOT NULL, kind text NOT NULL, -- new | renewal | expansion
  stage text NOT NULL,                         -- open | closed_won | closed_lost
  amount numeric NOT NULL, created_on date NOT NULL, closed_on date,
  owner_staff_id int NOT NULL REFERENCES raw.staff,
  products text NOT NULL,                      -- comma-separated SKU names
  notes text
);
CREATE TABLE raw.contracts (
  contract_id int PRIMARY KEY, account_id int NOT NULL, deal_id int NOT NULL,
  start_on date NOT NULL, end_on date NOT NULL, annual_value numeric NOT NULL
);
CREATE TABLE raw.support_tickets (
  ticket_id int PRIMARY KEY, account_id int NOT NULL, opened_on date NOT NULL,
  priority text NOT NULL, status text NOT NULL, subject text NOT NULL
);
CREATE TABLE raw.product_usage (
  account_id int NOT NULL, day date NOT NULL, active_users int NOT NULL, events int NOT NULL,
  PRIMARY KEY (account_id, day)
);
CREATE TABLE raw.loads (relation text PRIMARY KEY, loaded_at timestamptz NOT NULL);

CREATE VIEW semantic.staff AS SELECT staff_id, name, role FROM raw.staff;

CREATE VIEW semantic.accounts AS
SELECT a.account_id, a.name, a.status, a.region, a.plan, a.customer_since, a.churned_on,
       s.name AS owner_name,
       -- The two-table rule, done once here so no planner has to carry it out.
       CASE WHEN a.status = 'prospect'
            THEN (SELECT ds.name FROM raw.deals d JOIN raw.staff ds ON ds.staff_id = d.owner_staff_id
                  WHERE d.account_id = a.account_id AND d.stage = 'open' ORDER BY d.created_on DESC LIMIT 1)
            ELSE s.name END AS account_owner
FROM raw.accounts a LEFT JOIN raw.staff s ON s.staff_id = a.owner_staff_id;

CREATE VIEW semantic.deals AS
SELECT d.deal_id, d.account_id, d.deal_name, d.kind, d.stage, d.amount, d.created_on, d.closed_on,
       s.name AS owner_name, d.products, d.notes
FROM raw.deals d JOIN raw.staff s ON s.staff_id = d.owner_staff_id;

CREATE VIEW semantic.contracts AS
SELECT contract_id, account_id, start_on, end_on, annual_value FROM raw.contracts;

CREATE VIEW semantic.support_tickets AS
SELECT ticket_id, account_id, opened_on, priority, status, subject FROM raw.support_tickets;

CREATE VIEW semantic.product_usage AS
SELECT account_id, day, active_users, events FROM raw.product_usage;

CREATE TABLE app.answer_log (
  id serial PRIMARY KEY, question text NOT NULL, status text NOT NULL,
  bytes int NOT NULL, rows_inline int NOT NULL, rows_total int NOT NULL, critic text NOT NULL
);

-- The execution role: reads the semantic views and nothing else. NOLOGIN; the app switches to it
-- with SET LOCAL ROLE inside each read-only transaction.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'acme_ask_reader') THEN
    CREATE ROLE acme_ask_reader NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA semantic TO acme_ask_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA semantic TO acme_ask_reader;

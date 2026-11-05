# Step 2: Create the database

This step builds the empty structure of the ledger on Supabase. No data goes in yet.

## What each table is for (in simple words)

| Table | What it holds |
|---|---|
| companies | Your carrier entities (R A H Trans, FAST TRANS, and so on) |
| insurers | The insurance companies |
| policies | Each policy: which company, which insurer, number, dates, how often billed |
| drivers | Drivers, linked to a company and to their ID in Salesforce |
| policy_units | Each truck or driver covered by a policy, with dates and the agreed driver rate |
| source_documents | Every file or email we read, with a fingerprint so we never load it twice |
| insurer_charges | Every charge from the insurer: what we pay |
| driver_charges | Every insurance deduction from drivers: what we collect |
| bank_transactions | Actual money leaving the bank, as a second proof |
| exceptions | The problems found by the matching, in plain words |
| settings | Small adjustable values, such as the matching tolerance |

## Prompt

```
Create the database for the Insurance department on Supabase.

First, list my Supabase organizations and projects. If there is no suitable project, tell me the cost of creating a new one and wait for my yes. If I want a new one, name it insurance-ledger and use a US region.

Use migrations for all structure changes (not loose SQL), and name each migration clearly.

Create these tables. Every table has an id (uuid, primary key), created_at, and updated_at.

companies: name (unique), mc_number, dot_number, active (boolean, default true).
insurers: name (unique).
policies: company_id, insurer_id, policy_number, coverage_type (text, for example auto liability, cargo, physical damage, occupational accident), effective_date, expiration_date, billing_frequency (monthly, quarterly, annual, other), notes. Policy number must be unique per insurer.
drivers: company_id, full_name, tms_driver_id (the ID in Salesforce, may be empty at first), active.
policy_units: policy_id, unit_type (truck or driver), unit_ref (unit number, VIN last 6, or driver name), driver_id (optional), added_date, removed_date (empty while active), agreed_driver_rate (decimal, optional), rate_period (weekly or monthly).
source_documents: kind (insurer_bill, bank_statement, salesforce_export), drive_file_id, gmail_message_id, file_hash, received_at, parse_status (pending, parsed, needs_review, failed), notes. file_hash must be unique when present.
insurer_charges: company_id, policy_id, source_document_id, charge_date, period_month (first day of the month the charge belongs to), charge_type (premium_installment, unit_added, unit_removed, audit_adjustment, refund, fee, tax, other), unit_ref (optional), description, amount (decimal 12,2; positive means we owe or paid; refunds are negative), confidence (high or low), voided (boolean, default false), void_reason.
driver_charges: company_id, driver_id (optional), tms_record_id (unique), settlement_date, period_month, category, description, amount (decimal 12,2; positive means we collected; reversals are negative), raw_data (jsonb copy of the original record), voided, void_reason.
bank_transactions: company_id, source_document_id, txn_date, description, amount, account_last4, linked_insurer_charge_id (optional).
exceptions: company_id, period_month, code (text), severity (high, medium, low), insurer_charge_id (optional), driver_charge_id (optional), amount_difference, explanation (plain words), status (open, accepted, resolved), resolved_note, resolved_at. Add a unique key on (company_id, period_month, code, insurer_charge_id, driver_charge_id) so rerunning the matching never duplicates an exception.
settings: key (unique) and value. Insert these: match_tolerance_usd = 1.00, driver_month_basis = settlement_date.

Add indexes on company_id and period_month for the charge tables.

Turn on Row Level Security on every table and add no public policies, so nothing is readable from the internet.

When done, run the Supabase security advisor, fix anything it flags, and show me: the list of tables, the list of columns per table, and the advisor result. Do not insert any data yet.
```

## Check

- Claude shows all 11 tables and their columns.
- The security advisor result is clean, or every warning has been fixed or explained.
- If any table is missing, say so and have it fixed before moving on.

## Things to know

- Positive and negative amounts matter. A refund from the insurer is a negative charge. A reversed driver deduction is a negative collection. This keeps the history honest without deleting anything.
- The period_month field is the first day of the month a charge belongs to. All monthly matching depends on it.
- Row Level Security with no public policies means the database is closed to the internet. Only Claude, through your connected account, reads and writes.

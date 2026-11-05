# Step 4: Insurer bills, inspect first, then load

This step teaches the system to read your insurer bills. It is in two parts. Part A only looks. Part B writes to the database, and only after you approve Part A.

## The question that decides everything

Part A must answer one question for each insurer: does the bill show one lump sum per policy (LUMP SUM), or one line per truck or driver (PER UNIT)?

- LUMP SUM means we can match only at the company level (total paid against total collected). This is still useful, because it shows which company is losing money on insurance.
- PER UNIT means we can also match driver by driver, which finds the exact source of every gap.

## Prompt

Replace the part in square brackets in Part B with your insurer names or email addresses.

```
Work on the insurer bills. Part A is inspection only. Do not write to the database in Part A.

Part A.
1. Open the Drive folder Insurance/03 Samples and read every insurer bill in it.
2. For each insurer, tell me in simple words: how the bill is laid out, whether it shows one total or one line per truck or driver, which fields are present (policy number, billing period, due date, amounts, taxes, fees), and anything unusual (credits, audits, mid-term changes).
3. Tell me clearly which case I am in for each insurer: LUMP SUM (one amount per policy) or PER UNIT (a line for each truck or driver). This decides how deep the matching can go.
4. Show me what you would extract from each sample as a table with these columns: company, policy number, charge_type, period_month, unit_ref, description, amount, confidence. Mark anything you are not sure about.
Stop and wait for my approval.

Part B (only after I approve Part A).
1. Create a Gmail label named Insurance/Bills if it does not exist, and search my Gmail for insurer bills using these sender addresses or words: [LIST INSURER EMAIL ADDRESSES OR NAMES]. Show me the list of emails found (date, sender, subject, attachment name) but do not label anything yet. Wait for my approval of the list.
2. After approval, extract the charges from each bill using the approved format. Create a source_documents row for each file, with the Gmail message ID or Drive file ID and a hash, and skip any document already loaded.
3. Insert into insurer_charges. Create policy_units rows when a bill lists trucks or drivers I have not loaded yet.
4. Show me per company and per month: the number of charges and the total amount, and list every row marked LOW_CONFIDENCE.
```

## Check

Pick one bill and add its lines yourself with a calculator. The total must match what the database shows, to the cent. If it does not, do not continue. Tell Claude which line is wrong, and it fixes the reading rule.

## If an insurer's bills keep failing

Some insurers send scanned images or very odd layouts. Ask that insurer for an Excel or CSV statement instead. Most of them can send one, and it removes the reading problem completely.

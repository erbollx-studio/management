# Step 0: What you do yourself (no prompt)

This step needs no prompt. It is the preparation that makes every later step possible.

## 1. Connect the tools

1. Add the Salesforce connector. In Claude, open the connector list and connect "Salesforce - Beta", then sign in with the account that can see the TMS data. If your TMS is not built on Salesforce, or you prefer not to connect it, the fallback is a scheduled Salesforce report exported to a Google Drive folder. Claude can read that file just as well.
2. Check that Gmail and Google Drive are connected. Claude will use both.
3. Check that Supabase is connected. This is where the database will live.

## 2. Make the Google Drive folders

Create one folder called Insurance, and inside it four folders:

```
Insurance/
  01 Inbox        new bills and exports that have not been processed yet
  02 Processed    files that were loaded into the database
  03 Samples      real examples used to teach the system the formats
  04 Reports      monthly reports and exports from the database
```

## 3. Collect real samples into 03 Samples

You may blank out names, but keep the amounts and the column layout exactly as they are.

1. One insurer bill from each insurer you use. The last 2 or 3 months if you have them.
2. One bank statement page that shows an insurance debit.
3. One Salesforce report or export that shows insurance deductions from driver settlements.

## 4. Write your reference list

Write this in a plain note. Claude will turn it into a table in Step 3.

```
Companies:
- company name, MC number, DOT number (if you have them)

Insurers:
- insurer name

Policies:
- company, insurer, policy number, coverage type (auto liability, cargo,
  physical damage, occupational accident, and so on),
  start date, end date, how often it is billed (monthly, quarterly, annual)
```

## Check

- The Salesforce, Gmail, Drive, and Supabase connections all exist.
- The four Drive folders exist.
- The samples are inside 03 Samples.
- Your reference list is written.

When all four are true, go to file 02.

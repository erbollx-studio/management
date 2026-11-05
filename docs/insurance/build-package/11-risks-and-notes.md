# Risks and notes

## What will probably go wrong

### 1. Bad reading of PDF bills

Some insurers send scanned images or very odd layouts. Every uncertain number is marked LOW_CONFIDENCE and shown to you, so nothing silent gets in. If one insurer's bills keep failing, ask that insurer for an Excel or CSV statement.

### 2. Insurance deductions are not clean in Salesforce

If the insurance deduction shares a category with other things (escrow, general deductions), the collected total will be wrong. Step 5 Part A is where this is caught. The 10 and 10 example records exist to prove the rule before anything is loaded.

### 3. People forget to update the policy register

The system only works if new trucks and drivers are added to the policy register when they are added to a policy. Otherwise you will get many UNKNOWN_UNIT exceptions. Make one person responsible for this. It can be you.

### 4. Timing differences

Insurers bill monthly, drivers pay weekly, and deductions near a month end can land in the next month. The running gap in the monthly view handles this. A single month showing REVIEW is not always a real problem. A running gap that keeps growing is.

### 5. The system is only as good as the first month you check

This is why Step 7 exists. Do not skip it.

## Safety notes

- Everything in the database comes with a source file or record ID. If a number is questioned, open the source.
- Nothing is deleted. Wrong rows are marked voided with a reason.
- Bank account numbers, SSNs, and full card numbers never go into the database. Only the last 4 digits.
- The dashboard is private by default. It contains money and driver information, so think before sharing it.
- The database is closed to the internet. Only your connected account reads and writes.

## Backups

Export the tables to Drive every month (folder Insurance/04 Reports). This database holds the only complete picture of your insurance money, so keep your own copy.

## About driver charge-backs

As far as I know, US owner-operator lease rules require that charge-backs to a driver are clearly stated in the lease, and that the driver can get copies of the documents behind the charge. This is not legal advice. Confirm it with your counsel. The ledger helps, because every driver charge has the matching insurer line next to it.

## Next departments

When this department works, the same structure repeats for the next one: sources, one central ledger, rules, and a short list of exceptions. Only the sources and the rules change.

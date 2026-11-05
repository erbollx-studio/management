# Step 6: The matching rules

This is the core of the department. It compares what we paid with what we collected, and it writes down every difference with a reason.

## How the matching works in simple words

Level 1 is company and month. For each company and each month, add up everything the insurer charged and everything collected from drivers. The difference is the gap. This level works even when the insurer bills one lump sum.

Level 2 is driver or truck within the month. It works only when the insurer bill has one line per unit. It finds exactly which truck or driver causes a gap.

Why the month and not the week: insurers usually bill monthly while drivers are charged weekly. A weekly comparison would show false gaps all the time. A running gap (the sum of all earlier gaps) handles deductions that land in the next month.

## The exception codes

| Code | Meaning |
|---|---|
| UNRECOVERED_CHARGE | The insurer charged a unit or driver and we collected nothing. We paid from our own pocket. |
| UNBILLED_DEDUCTION | We collected from a driver who has no insurer line that month. Either we overcharged him or the truck was dropped from the policy. |
| AMOUNT_MISMATCH | Both sides exist but the difference is above the tolerance. |
| UNKNOWN_UNIT | The bill has a unit that is not in policy_units. |
| DUPLICATE_SUSPECT | Two insurer charges with the same policy, unit, month, and amount. |
| MISSING_BILL | A policy that should bill this month has no insurer charge. |
| REFUND_PENDING | A unit was removed from a policy but no refund or credit line appears within 60 days. |

## Prompt

```
Build the matching for the Insurance department as SQL views and one repeatable function, so it can be rerun at any time without creating duplicates. Show me the definitions before you create them and wait for my approval.

Level 1, company and month (build this first).
For every company and period_month:
 paid = sum of insurer_charges.amount where voided is false.
 collected = sum of driver_charges.amount where voided is false and category is insurance.
 gap = paid minus collected.
 running_gap = the sum of all gaps up to and including this month (because deductions near a month end can land in the next month).
 status = OK if the absolute gap is within settings.match_tolerance_usd, otherwise REVIEW.
Create a view called v_company_month with these columns, plus the number of charges on each side.

Level 2, driver or truck within a month (only where the insurer bill is PER UNIT).
Match an insurer charge to driver charges by unit_ref or driver through policy_units, inside the same company and period_month. Compare the insurer amount with the total collected from that driver. If policy_units has an agreed_driver_rate, also compare collected with the expected amount (rate times the number of weeks in service).

Exception codes to create, each with a plain-words explanation that names the company, the month, the driver or unit, and the amounts:
 UNRECOVERED_CHARGE: the insurer charged a unit or driver and we collected nothing.
 UNBILLED_DEDUCTION: we collected from a driver who has no insurer line in that month.
 AMOUNT_MISMATCH: both exist but the difference is more than the tolerance.
 UNKNOWN_UNIT: the bill has a unit that is not in policy_units.
 DUPLICATE_SUSPECT: two insurer charges with the same policy, unit, month, and amount.
 MISSING_BILL: a policy that should bill this month has no insurer charge.
 REFUND_PENDING: a unit was removed from a policy but no refund or credit line appears within 60 days.
Severity: high if the difference is above 250 USD or the code is UNRECOVERED_CHARGE, medium for other mismatches, low for the rest.

Rules for rerunning: never touch exceptions whose status is accepted or resolved. Update open exceptions if the numbers changed. Close an open exception automatically if the data now matches, and write why in resolved_note.

After I approve, create them, run them, and show me: the full v_company_month table, and the number of exceptions by company and by code.
```

## Check

The totals in v_company_month must equal the totals you saw at the end of Step 4 (paid) and Step 5 (collected). If they differ, there is a bug in the matching. Fix it before going on.

## A note about driver charge-backs

When a driver is charged for insurance, he is entitled to see what the charge is based on. As far as I know, the US rules for owner-operator leases require that charge-backs are clearly stated in the lease and that the driver can get copies of the documents behind them. This is not legal advice, so confirm it with your counsel. The ledger helps either way, because for every driver charge the matching insurer line sits right next to it.

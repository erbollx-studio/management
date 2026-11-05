# Step 7: Test with one month you know by heart

Do not skip this step. A system that was not checked against a month you know will not be trusted by anyone, and it should not be.

## How to choose the month

Pick one company and one month where you remember the real numbers: roughly what the insurer charged and roughly what drivers paid. A month with a known event is even better, for example a truck that was added or removed in the middle of the month.

## Prompt

Replace the parts in square brackets.

```
Run an acceptance test on one company and one month: [COMPANY] and [MONTH]. I know the real numbers: the insurer charged about [AMOUNT] and drivers paid about [AMOUNT].

1. Show me every insurer charge and every driver charge for that company and month, line by line, with the source of each (file name or Salesforce ID).
2. Show the totals, the gap, and every exception, with the explanation.
3. For each exception, tell me your best explanation of the cause and what I should check to confirm it. Say clearly where you are guessing.
4. Tell me what you could not verify.
Do not change any data in this step.
```

## Check

Go through the exceptions one by one and decide for each:

- Real problem: the system found a true gap. Good.
- Data error: a bill or deduction was read wrongly. Tell Claude which line, and it fixes the reading rule.
- Rule error: the matching logic was too strict or too loose. Tell Claude, and it adjusts the rule.

Then repeat the test on a second month. Only when two different months give results you believe, go to the dashboard.

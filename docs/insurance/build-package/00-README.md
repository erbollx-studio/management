# Insurance Department: Build Package

This package contains everything needed to build the Insurance department of the centralized work system. The goal: track how much we pay for insurance for each company, track how much we charge the drivers of that company, and match the two so that every gap is visible and explained.

## The idea in simple words

We pay the insurer. We collect part or all of that money back from the drivers through their settlements. If the two do not match, someone is losing money (usually us) or someone is being overcharged (usually a driver). Today this is checked by hand, or not checked at all. This system collects all the numbers in one database, compares them every week, and shows only the problems.

## Architecture (text version)

```
  SOURCES (what we read)
  +---------------+  +---------------+  +----------------+  +-----------------+
  | Insurer bills |  | Bank debits   |  | TMS Salesforce |  | Policy register |
  | Gmail, portal |  | Cash that     |  | Driver charges |  | Rates and dates |
  |  (we pay out) |  | really left   |  | (we collect)   |  | (kept by us)    |
  +-------+-------+  +-------+-------+  +--------+-------+  +--------+--------+
          |                  |                   |                   |
          +------------------+---------+---------+-------------------+
                                       |
                           +-----------v------------+
                           |     CENTRAL LEDGER     |
                           | One database (Supabase)|
                           | One section per company|
                           +-----------+------------+
                                       |
                           +-----------v------------+
                           |    MATCHING ENGINE     |
                           | Paid by us versus      |
                           | collected from drivers |
                           +-----------+------------+
                                       |
                +----------------------+----------------------+
                |                      |                      |
        +-------v------+      +--------v-------+      +-------v------+
        |  Company     |      |  Exceptions    |      |  Monthly     |
        |  dashboard   |      |  list          |      |  report      |
        +--------------+      +----------------+      +--------------+
```

## Files in this package, in the order to use them

| File | What it is |
|---|---|
| 00-README.md | This overview |
| 01-step0-manual-setup.md | What you do yourself before any prompt |
| 02-step1-standing-rules.md | The 10 rules Claude must always follow in this project |
| 03-step2-create-database.md | Prompt: create the database and tables |
| 04-step3-reference-data.md | Prompt: load companies, insurers, policies |
| 05-step4-insurer-bills.md | Prompt: read insurer bills, then load them |
| 06-step5-salesforce-driver-charges.md | Prompt: read driver deductions from Salesforce, then load them |
| 07-step6-matching-rules.md | Prompt: build the matching logic and the exception codes |
| 08-step7-acceptance-test.md | Prompt: test on one month you know by heart |
| 09-step8-dashboard.md | Prompt: build the dashboard |
| 10-step9-weekly-routine.md | Prompt: schedule the weekly automatic run |
| 11-risks-and-notes.md | What will probably go wrong, and how to handle it |

## How to use it

1. Do the steps in order. Do not skip ahead.
2. Each prompt file has a "Check" section. Do not go to the next step until the check passes.
3. Paste each prompt into the Project chat (Automation of all my workflow). Replace anything in [SQUARE BRACKETS] with your own information first.
4. Steps 4 and 5 start with an inspection part (Part A). Claude must look at your real bills and your real Salesforce data before writing anything. Never let it guess the columns or the amounts.
5. Nothing is created in the database until you approve the design in the step that creates it.

## Important warning

These prompts were written before seeing your real insurer bills and your real Salesforce data. If the reality is different from the assumptions (for example, the insurer bills one lump sum instead of one line per truck), the matching depth changes, but the structure stays the same. This is why the first matching level is company and month, and the driver level comes second.

# Step 9: The weekly routine

Until now, you sent each task by hand. This step makes the system run itself every Monday morning and send you a short summary.

## Why the prompt looks long

A scheduled task starts a fresh session every time. It has no memory of this chat. So the prompt must contain every instruction the task needs. This is why it repeats the rules and the steps.

## Prompt

```
Set up a weekly scheduled task for the Insurance department. It runs every Monday morning, Bishkek time, around 08:00.

Each run must be fully self-contained, because it starts in a new session with no memory of this chat. The task does this, in order:
1. Read the standing rules for the Insurance department project (the 10 rules I gave you) and follow them.
2. Search Gmail for new insurer bills since the last loaded document, using the sender list already used in this project. Extract them with the same approved format, create source_documents rows, and insert the charges. Skip anything already loaded.
3. Also read any new files in the Drive folder Insurance/01 Inbox, load them the same way, and move each processed file to Insurance/02 Processed (the only move you may do).
4. Pull new insurance deductions from Salesforce, read-only, since the last load.
5. Rerun the matching function.
6. Refresh the dashboard artifact with the new snapshot.
7. Send me one short message: how many new bills and deductions were loaded, the current gap per company, the new high-severity exceptions (one line each), and anything that failed or needs my approval.
Never email anyone, never edit Salesforce, and if a step fails, say which step and continue with the others.

First tell me which approval setting the task got, since a scheduled run usually has nobody present to approve actions. Then do not wait for Monday: run it once now and show me the result.
```

## Check

The first manual run must give the same numbers as the dashboard from Step 8. Only then do you trust the Monday run.

## About approvals

A scheduled task often runs with nobody present to approve actions. If the task is set to ask for approval, it will stop and wait. Claude will tell you which setting the task received. If it asks for approval, you can switch the task to automatic approval in its settings, if your organization allows it. Think carefully before doing so, because the task writes to your database. The standing rules limit it to reading outside systems, but the choice is yours.

## Optional additions for later

- A monthly export of all ledger tables to Insurance/04 Reports, as a backup you own.
- A short message when any exception with severity high appears, instead of waiting for Monday.

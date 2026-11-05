# Insurance department project

Standing rules from the owner. Follow these in every task.

1. Money safety. Never invent, estimate, or round an amount. If a number is unclear in a document, mark it LOW_CONFIDENCE and show it to me. Store amounts as exact decimals in USD.
2. Preview before writing. Before the first insert of any new kind of data, show me a preview table of what you plan to write and wait for my approval. After I approve the format, you may continue with the same format without asking, but flag anything that does not fit.
3. Read-only on outside systems. In Salesforce, Gmail, and Google Drive you only read. Never edit, delete, label, send, or move anything there, except where a prompt explicitly names a label or folder to create or a file to move.
4. Never delete rows in the database. If something is wrong, mark it voided with a reason, so the history stays.
5. Traceability. Every row in the ledger must point to its source: a Drive file ID, a Gmail message ID, or a Salesforce record ID. If a row has no source, do not insert it.
6. No duplicates. Running the same import twice must change nothing. Use the source ID or a file hash to detect repeats.
7. Companies stay separate. Every row belongs to exactly one company. Never add numbers across companies unless I ask for a total.
8. Privacy. Do not put bank account numbers, SSNs, or full card numbers into the database. Last 4 digits only.
9. Tell me what you did in plain, simple words: what was read, what was written, how many rows, and what needs my attention. No emojis. Do not use long dashes.
10. If you are unsure about anything, ask me one clear question instead of guessing.

## How the agents work

The roles, the order they run in, and the handoff format are in `docs/insurance/agent-roles.md`. The agent files are in `.claude/agents/`. The build package is in `docs/insurance/build-package/`.

For the main session (the coordinator):
- Only you talk to the user, hold approvals, start agents, and publish.
- Give each job to its role. Do not read bills or write ledger rows yourself.
- One approval covers one batch, identified by the sha256 of its `batch.json`.

For agents:
- You cannot ask the user. Where a rule says "show me" or "ask me", stop and put it in your final report to the coordinator.
- Never act as if something was approved unless the coordinator's message says APPROVED for that exact item.
- Stay inside your role. If the task needs a tool you do not have, stop and report it.
- Work files go in `work/`, which is git-ignored. Never commit them. They hold names and amounts.

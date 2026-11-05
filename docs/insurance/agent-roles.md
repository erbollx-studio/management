# Insurance department: agent roles

Each agent has one job and only the tools for that job. Roles follow the jobs inside each step, not one agent per step, because some steps hold two jobs that must not sit in the same hands. Example: the agent that reads a bill must not also be the one that writes it to the ledger.

The build package these roles serve is in `docs/insurance/build-package/`. The agent files are in `.claude/agents/`.

## The coordinator

The main session is the coordinator. It is the only one that:
- talks to the user and holds approvals
- starts agents (agents cannot start other agents)
- publishes the dashboard and creates the scheduled task

The coordinator does not read bills or write rows itself. It passes work between roles and shows the user every preview.

## Roles

| Role | Job | Reads | Writes |
|---|---|---|---|
| setup-auditor | Checks Step 0 is done | Drive folder list, Gmail labels, Supabase project list | Nothing |
| ledger-architect | Designs and builds the database structure | Supabase catalog | Migrations only, after approval |
| reference-clerk | Turns your note into company, insurer, policy rows | Your note | Batch file only |
| bill-reader | Reads insurer bills and bank pages | Gmail, Drive | Batch file only. May create the Gmail label Insurance/Bills |
| tms-reader | Reads driver insurance deductions | Salesforce (when connected), Drive exports | Batch file only |
| ledger-writer | The only role that writes data rows | Batch files | Ledger rows, voids, matching run |
| matching-engineer | Builds the matching views and function | Supabase | Migrations only, after approval |
| acceptance-auditor | Checks designs and tests a known month from the originals | Gmail, Drive, Supabase (SELECT) | Its report only |
| dashboard-builder | Builds the dashboard snapshot | Supabase (SELECT) | Dashboard files only |
| inbox-filer | Moves loaded files from 01 Inbox to 02 Processed | Drive metadata | That one Drive move only |

## Which roles run in each step

| Step | Order of roles |
|---|---|
| 0 Manual setup | You do the setup. setup-auditor checks it. |
| 1 Standing rules | No agent. The rules are in CLAUDE.md, which every agent loads. |
| 2 Create database | ledger-architect (DESIGN), acceptance-auditor (REVIEW), you approve, ledger-architect (APPLY) |
| 3 Reference data | reference-clerk, you approve, ledger-writer |
| 4 Insurer bills | bill-reader (INSPECT), you approve, bill-reader (FIND), you approve the email list, bill-reader (EXTRACT), you approve, ledger-writer |
| 5 Driver charges | tms-reader (INSPECT), you approve, tms-reader (EXTRACT), you approve, ledger-writer, then ledger-writer again with the same batch to prove nothing changes |
| 6 Matching | matching-engineer (DESIGN), acceptance-auditor (REVIEW), you approve, matching-engineer (APPLY) |
| 7 Acceptance test | acceptance-auditor (ACCEPT), on two different months |
| 8 Dashboard | dashboard-builder, coordinator publishes |
| 9 Weekly run | bill-reader, ledger-writer, tms-reader, ledger-writer, inbox-filer, ledger-writer (matching), dashboard-builder, coordinator republishes and sends the summary |

## Separation of duties

These four rules are why the roles are split this way:
1. Readers never write to the database.
2. The writer never reads outside systems. It can only write what a reader extracted and you approved.
3. Builders (architect, matching engineer, dashboard builder) never load data.
4. The auditor never fixes what it checks, and never reuses the readers' batch files.

## Handoff files

Readers hand work to the writer through files in `work/` (git-ignored, never committed, because the files hold names and amounts).

```
work/batches/<YYYYMMDD-HHMM>-<kind>/
  batch.json    the rows to write
  preview.md    what the user sees before approving
work/downloads/<file-id>/
  one folder per downloaded file, nothing else inside
```

`batch.json`:

```json
{
  "kind": "insurer_charges | driver_charges | bank_transactions | reference",
  "format": "insurer-example-v1",
  "prepared_by": "bill-reader",
  "prepared_at": "2026-11-05T18:00:00Z",
  "source_documents": [
    {"kind": "insurer_bill", "drive_file_id": "...", "gmail_message_id": null,
     "attachment_name": "...", "file_hash": "sha256:..."}
  ],
  "rows": [
    {"source": {"file_hash": "sha256:...", "page": 1, "line": 4},
     "company": "...", "policy_number": "...", "charge_type": "premium_installment",
     "period_month": "2026-10-01", "unit_ref": "...", "description": "...",
     "amount": "1234.50", "confidence": "high", "note": ""}
  ],
  "flags": [
    {"source": {"file_hash": "sha256:..."}, "problem": "footing gap", "details": "lines 4980.00, printed total 4985.00"}
  ],
  "totals": [{"company": "...", "period_month": "2026-10-01", "rows": 12, "amount": "4980.00"}]
}
```

Amounts are always strings. Never numbers.

## How approval works

1. A reader returns the batch path and the sha256 of `batch.json`.
2. The coordinator shows you `preview.md`.
3. You approve.
4. The coordinator tells the writer: the batch path, APPROVED, and the sha256.
5. The writer recomputes the sha256. If the file changed after you saw it, the writer writes nothing.

After you approve a format once (rule 2), the coordinator records it in the ledger setting `approved_format.<name>`. Later batches of the same format may be written without asking, but flagged rows and low confidence rows are never written without you. They are listed in the summary.

## Known limits

- Salesforce is not connected yet. tms-reader has Drive tools only and works from exports until then.
- There is no OCR on the machine. A scanned image bill cannot be read and goes to flags.
- Gmail attachments are fetched as the whole raw email. A large attachment may fail. The fix is to save that bill to `Insurance/01 Inbox`.
- SQL tools cannot be limited to reading. The auditor and dashboard builder are read-only by instruction, and the database guards (no delete, frozen amounts) are the real protection.
- The agents load from the branch a session starts on. The weekly scheduled task needs these files on the default branch.

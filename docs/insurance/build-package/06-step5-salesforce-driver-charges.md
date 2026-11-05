# Step 5: Driver charges from Salesforce, inspect first, then load

This step reads what the drivers were charged for insurance. Again it is in two parts. Part A only looks. Part B loads, and only after you approve Part A.

## The risk in this step

The collected total is only correct if insurance deductions can be told apart from other deductions (escrow, fuel, advances, and so on). If the category in Salesforce is not clean, the collected number will be wrong. Part A exists to catch this before anything is loaded.

## Prompt

Replace [NUMBER] in Part B with how many months back you want to load, for example 6.

```
Work on the driver insurance deductions from our TMS in Salesforce. Use read-only access. Never write anything to Salesforce.

Part A, inspection only.
1. Look at how our Salesforce is organized. Find the objects and fields that hold driver settlements and deductions. Also read the sample export in Insurance/03 Samples.
2. Tell me in simple words: which object and fields hold the driver, the company (carrier), the settlement date, the deduction type or category, and the amount. Tell me how insurance deductions can be told apart from other deductions (a category name, a code, a description pattern).
3. Show me 10 real example records that you believe are insurance deductions and 10 that you believe are not, so I can confirm the rule.
4. Tell me what each field is called in Salesforce and what it maps to in my driver_charges table.
Stop and wait for my approval.

Part B, after I approve.
1. Load the last [NUMBER] months of insurance deductions. For each record save the Salesforce record ID as tms_record_id, the original record as raw_data, and set period_month using the setting driver_month_basis.
2. Match each record to a drivers row by tms_driver_id. If the driver does not exist yet, create it and tell me how many you created.
3. A record that was reversed or corrected in Salesforce must be stored with a negative amount, never deleted.
4. Show me per company and per month: the number of deductions and the total collected, and list any record that has no company or no driver.
5. Running this again must change nothing, because tms_record_id is unique. Prove it by running it twice and showing me the row counts.
```

## Check

Pick one driver and one week. Compare the amount in the database with what you see in Salesforce. They must be identical.

## If Salesforce is not connected

Schedule a Salesforce report that exports insurance deductions to the Drive folder Insurance/01 Inbox as a CSV, and tell Claude to read that file instead. The rest of the prompt stays the same, and the CSV row ID is used as tms_record_id.

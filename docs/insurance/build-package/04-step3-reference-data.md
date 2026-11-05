# Step 3: Load companies, insurers, and policies

This is the only data you type by hand. Everything else comes from real documents. Take the time to get it right, because every later step depends on these rows.

## Prompt

Replace the part in square brackets with the note you wrote in Step 0.

```
Load the reference data. Here is my list: [PASTE YOUR NOTE FROM STEP 0 HERE: companies, insurers, policies with policy number, dates, billing frequency].

Do this in order:
1. Show me a preview of the rows you will create in companies, insurers, and policies as three small tables. Point out anything missing or unclear (for example a policy with no end date) and ask me instead of guessing.
2. Wait for my approval.
3. Insert them.
4. Then show me a table: each company, how many policies it has, and which coverage types.

Do not create policy_units or drivers yet. They come from the real files.
```

## Check

- The final table matches what you know about your companies.
- Fix any difference now, before moving on.

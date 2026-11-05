# Step 8: The dashboard

The dashboard is the screen you open to see the state of insurance across all companies in five seconds.

## Prompt

```
Build the Insurance dashboard as a private Dashboard artifact (if that type is not available, a single HTML page). Read the data from Supabase now and embed it as a snapshot, with the time of the snapshot shown at the top. Do not make it public and do not share a link.

Layout:
1. Top bar: a month selector and a company filter. Default is the latest complete month and all companies.
2. One card per company: paid, collected, gap, and a status label OK or REVIEW. Sort so the worst gap is first.
3. A 12 month bar chart per selected company: paid versus collected.
4. A total of the unrecovered amount for the year so far, per company, because this is money we paid from our own pocket.
5. An exceptions table: company, month, code, severity, driver or unit, difference, explanation, status. Highest severity first.
6. A short note at the bottom explaining how the numbers are calculated.

Style: plain, quiet, easy to read on a phone. Large numbers, little decoration. No emojis. Do not show driver names outside the exceptions table.

After it is published, tell me in one sentence what it shows, and tell me how to refresh it (the exact words I should send you).
```

## Check

Open the dashboard on your phone. If you cannot see the worst company and its gap within 5 seconds, tell Claude, and it simplifies the layout.

## Good to know

- The dashboard is a snapshot. It shows the data as it was when it was built or refreshed. The weekly routine in Step 9 refreshes it automatically.
- It is private by default. Share it only if you decide to, and remember that it contains driver and money information.

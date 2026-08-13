# quickparse — verified cases & deliberate decisions

Checked by executing the module directly (Node type-stripping) on 2026-08-13 (Thursday), UTC.

## Happy paths

| input | title | patch |
| --- | --- | --- |
| `Позвонить маме завтра в 15:30 !высокий #Работа 30м` | `Позвонить маме` | due_at = tomorrow 15:30, priority 3, estimate 30, project Работа |
| `отчёт пт 1.5ч !2` | `отчёт` | due_at = next Friday end-of-day, priority 2, estimate 90 |
| `купить билеты 05.09 в 9` | `купить билеты` | due_at = 05.09 09:00 |
| `встреча 15:00 #Дом` | `встреча` | due_at = today 15:00, project Дом |
| `просто задача без токенов` | unchanged | `{}` |

## Deliberate decisions

- **Bare numbers stay in the title** — a time without «в» must carry a colon
  («15:00» matches, «15» alone does not), so «купить 5 яблок» is never eaten.
- **«в» is consumed before a clock or a weekday** («в 15», «в пт»), otherwise
  the preposition would dangle in the title. It stays put anywhere else.
- **Weekday = next occurrence, never today** — «чт» typed on Thursday means
  next Thursday; «сегодня» already covers the same-day case.
- **Yearless dd.mm in the past rolls to next year** — «01.01» in August means
  the coming January, nobody quick-adds into the past.
- **Impossible dates are not dates** — «31.02» fails the round-trip check and
  stays in the title instead of silently becoming March 3rd.
- **First match of each kind wins** — a second date/priority/etc. token falls
  through into the title so the user sees it was not consumed.
- **`#проект` matches whole names case-insensitively, single token only** —
  multi-word project names are not matched; an unknown `#слово` stays in the
  title untouched.
- **Date only → end of local day** (same anchor as `dateInputToDueAt`); an
  explicit time makes the deadline exact; time only → today at that time.
- Only clock read is `new Date()` at call time; no other side effects.

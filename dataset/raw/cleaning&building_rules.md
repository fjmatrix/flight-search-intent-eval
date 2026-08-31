Use this decision rule:
| Difference | Action |
|---|---|
| duplicated id | Remove
| Case, whitespace, punctuation, or repeated message | Remove |
| Typo or filler with identical meaning and identical `expect` | Usually remove; optionally keep one noisy variant |
| Different wording but identical `expect` | Keep at most two: one clean and one meaningfully different/noisy phrasing |
| Changes any expected field | Keep both as a valuable minimal pair |
| Adds a preference the schema cannot represent | Keep at most one robustness case for that preference |
| Incomplete or unlabelable query | Exclude, or deliberately label as invalid—don’t guess |
| Duration, date, or filter that could attach to more than one leg | Rewrite it next to the leg it modifies; exclude if no phrasing pins it |

Examples from these rows:
- Rows 161 vs. 162 are 98.5% text-similar, but January 15 vs. 16 changes departure_date: keep both.
- Rows 29 vs. 30 differ only by YYJ vs. YVR, but that changes the origin: keep both.
- Rows 90 vs. 91 change Davao to Manila: keep both.
- Rows 137 vs. 138 add “no layovers,” changing max_stops to 0: keep both.
- Rows 145–147 differ only by punctuation/repetition: keep one.
- Rows 229, 232, and 233 differ only by capitalization: keep one.
- Rows 13 vs. 14 add “Cheapest.” Because generic cheapness has no representable field in the current expect schema, keep one core case—or one extra robustness case, not both as equally weighted coverage.

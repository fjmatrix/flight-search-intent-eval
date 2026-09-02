## What's under test

A system prompt (`prompts/v6.txt`) + one raw traveler input → a JSON object conforming to `schema/search-input.json`, produced via each vendor's structured-output mode. "Today" is pinned in [eval.config.json](eval.config.json) (`01/01/2026`) and injected into the prompt, so date arithmetic is deterministic and replayable. Providers sit behind one adapter interface, so nothing in the grader knows which vendor answered.

## Coverage

244 cases across `dataset/en.jsonl` (150), `de.jsonl` (50), `es.jsonl` (44), tagged into report buckets:

| tag                        | n             | what it stresses                                      |
| -------------------------- | ------------- | ----------------------------------------------------- |
| roundtrip / oneway / multi | 153 / 59 / 12 | trip shape, leg ordering                              |
| flexible-date              | 116           | "October or November", "next 10–15 days"              |
| fuzzy-location             | 109           | "beach towns in Southeast Asia" — no IATA code exists |
| invalid-date               | 7             | dates already past or nonexistent                     |
| invalid-others / off-topic | 3 +           | reads like a query but can't become a search          |

Cross-cutting, untagged: passengers, cabin, stops/price/bags/connection filters, multilingual input (the query is Spanish/German, the output spec is not).

## How output is scored against `expect` (Golden Label)

`expect` is a set of **partial assertions**; 11 independent graders each read the slice they own and return one of three values:

- **fail** — the field was asserted and the model missed it
- **pass** — asserted and satisfied
- **null / not applicable** — the case says nothing about that field, so it stays out of the denominator entirely

A case passes only if no grader returns `false` ([src/run.ts:240](src/run.ts:240)). Per-grader pass rates and per-tag case-pass rates are reported separately, so you can see _which_ dimension a model is losing on.

What makes it non-brittle:

- **Dates are windows.** `"03/15/26"` demands that day; `"10/01/26-10/31/26"` accepts anything inside October. The model's answer (itself possibly a range) must be _contained_ by the expected window.
- **Durations are ranges,** same containment rule; `"21-"` is open-ended.
- **Airports are alternative sets.** `any_code: ["ORD","CHI","MDW"]` — every location the model returns must be in the accepted set.
- **Regions are compared by meaning.** Fuzzy cases list accepted spellings; exact matches short-circuit, leftovers are scored by embedding cosine against `text-embedding-3-small` at threshold 0.72.
- **Stay normalization.** `return_date` and `duration` express the same fact, so whichever the model omitted is derived from the other before comparison ([src/grade.ts:64](src/grade.ts:64)) — a model isn't punished for choosing a different, equivalent encoding.
- **Two graders take no expected value at all.** `SANE` (no past departures, return after departure, multi legs ascending) and `SHAPE` (trip count matches search type, `return_date`/`duration` never both set) are invariants of any valid search, so every case is scored on them — and deliberately read the raw model output, not the normalized one.

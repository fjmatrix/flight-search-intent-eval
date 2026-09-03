---
pretty_name: Flight Search Intent Eval
license: mit
language:
    - en
    - de
    - es
task_categories:
    - text-generation
tags:
    - eval
    - benchmark
    - travel
    - intent-parsing
    - structured-output
    - multilingual
size_categories:
    - n<1K
configs:
    - config_name: default
      data_files:
          - split: en
            path: en.jsonl
          - split: de
            path: de.jsonl
          - split: es
            path: es.jsonl
---

# Flight Search Intent Eval

244 real flight search queries in English, German and Spanish, each paired with the
structured search specification a model should produce from it.

This is the step _before_ booking: turning one messy sentence into origin, destination,
dates, duration, passengers, cabin and filters. That specification decides which
itineraries a traveler is ever shown, so grading it is grading whether the model
understood which flights they meant. τ-bench and similar benchmarks cover what happens
after a search spec exists. This covers what produces it.

| split     | cases   |
| --------- | ------- |
| `en`      | 150     |
| `de`      | 50      |
| `es`      | 44      |
| **total** | **244** |

## Results

Current leaderboard across 9 models:

**https://fjmatrix.github.io/flight-search-intent-eval/**

## A case

```json
{
    "id": "ow-europe-seasia-mar",
    "lang": "en",
    "text": "Europe to south east Asia mid march",
    "tags": ["oneway", "fuzzy-location", "flexible-date"],
    "expect": {
        "action": "get_tickets",
        "search_type": "oneway",
        "trips": [
            {
                "departure": { "fuzzy": true, "names": ["Europe"] },
                "arrival": { "fuzzy": true, "names": ["Southeast Asia", "South East Asia"] },
                "departure_date": "03/10/26-03/20/26"
            }
        ]
    }
}
```

`text` is the query as a traveler wrote it. `expect` asserts only the fields that query
actually determines — anything it does not mention is simply absent, and no grader is
run for it.

Expected dates are written against an anchor date of **01/01/2026**, which is also the
date the model under test is told is today. Change one and you must change the other.

## Tags

| tag              | cases |                                                                      |
| ---------------- | ----- | -------------------------------------------------------------------- |
| `roundtrip`      | 153   | out and back, stated as either a return date or a length, never both |
| `flexible-date`  | 116   | a window rather than a day                                           |
| `fuzzy-location` | 109   | a region, a country, or a vibe — no single IATA code                 |
| `oneway`         | 59    | no return stated                                                     |
| `multi`          | 12    | two or more trips, each with its own date, in ascending order        |
| `invalid-date`   | 7     | a date that cannot be honored — already past, or no such day         |
| `invalid-others` | 3     | reads as a flight query but cannot become a search                   |

## Grading

Eleven graders run per case. Each returns pass, fail, or **not applicable** — and
not-applicable stays out of the denominator, so no model is rewarded or punished for a
field its case says nothing about. A case passes only when every dimension it asserts
passes.

| grader                                        | asserts                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `gradeAction` `gradeSearchType`               | search vs. invalid; oneway / roundtrip / multi                                          |
| `gradeOrigin` `gradeDestination`              | the right airports — or, for places with no IATA code, the right region                 |
| `gradeDateRange` `gradeDuration`              | departure and return land inside the allowed window; the stay inside the allowed nights |
| `gradePassengers` `gradeCabin` `gradeFilters` | passengers, cabin, and the stops / price / bags / connection filters                    |
| `gradeDateSanity`                             | no departure before today, no return before departure, multi-city legs in order         |
| `gradeTripShape`                              | trip count matches the search type; `return_date` and `duration` never both set         |

The last two take no expected value. They hold for any valid search, so every case is
scored on them.

What keeps this from being brittle:

- **Dates are windows.** `"03/15/26"` demands that day. `"10/01/26-10/31/26"` accepts any
  day in October, because _"somewhere warm in October"_ has no single right answer.
- **Durations are ranges.** `"7"` is exactly a week, `"3-5"` accepts 3 to 5 nights,
  `"21-"` is three weeks or more.
- **Several airports can be right.** `{"any_code": ["ORD", "CHI", "MDW"]}` — Chicago is
  Chicago.
- **Regions are compared by meaning.** _"west europe"_, _"beach towns in Southeast Asia"_
  have no IATA code, so returned names are paired against expected ones by embedding
  cosine (≥ 0.80), one-to-one and order-free.


## Running it

The harness, prompt, JSON schema and per-vendor adapters live in the GitHub repo:

**https://github.com/fjmatrix/flight-search-intent-eval**

```bash
npm install && npm run eval
```

Each run writes per-model JSON plus a self-contained HTML leaderboard.

## License

MIT.

<p align="center">
  <img src="docs/hero.svg" width="880" alt="An English flight query parsed into a structured search spec, then scored on eleven grading dimensions">
</p>

<h1 align="center">flight-search-intent-eval</h1>

<p align="center">
  A eval framework for flight-search intent parsing: 244 search queries in three languages, and
  eleven independent graders deciding whether a model caught what users mean.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node 22+">
  <img src="https://img.shields.io/badge/OpenAI-412991?style=flat-square&logo=openai&logoColor=white" alt="OpenAI">
  <img src="https://img.shields.io/badge/Anthropic-D4A27F?style=flat-square&logo=anthropic&logoColor=white" alt="Anthropic">
  <img src="https://img.shields.io/badge/Gemini-4285F4?style=flat-square&logo=googlegemini&logoColor=white" alt="Google Gemini">
  <img src="https://img.shields.io/badge/cases-244-1F6FEB?style=flat-square" alt="244 cases">
  <img src="https://img.shields.io/badge/graders-11-6E56CF?style=flat-square" alt="11 graders">
  <img src="https://img.shields.io/badge/license-MIT-2F81F7?style=flat-square" alt="MIT license">
  <img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Ffjmatrix%2Fflight-search-intent-eval%2Fmain%2Fdocs%2Fbadge.json&style=flat-square" alt="Top model on the current leaderboard">
</p>

---

<p align="center">
  <strong><a href="https://fjmatrix.github.io/flight-search-intent-eval/">View leaderboard</a></strong>
  ·
  <a href="https://flightcat.io/">Flightcat.io</a>
</p>
Before a traveler is shown a itinerary, model has to understand the search intent — origin, destination, dates, duration, passengers, cabin, filters.

- `From Atlanta to Southeast Asia in april 2026 for 10 to 15 days.`

- `From France to Istanbul between July 3rd and July 6th. Two adults.`

This repo evaluate how models inteprets the user intent. τ-bench and friends grade the booking that comes after. The cases are real queries — deduped, de-identified, labeled. Every model sees the same 244 of them, under the same prompt and the same pinned date, Eleven independent graders, one adapter interface per vendor.

## Run it

```bash
npm install
cp .env.example .env   # OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY
npm run eval
```

Each run writes `results/<run-id>/<model>.json` and a self-contained `index.html` leaderboard —
no server, just open it. Re-render any run with `npm run dashboard -- results/<run-id>`.

Which models a run calls is the `models` array in `eval.config.json` — a provider, a model id,
`max_tokens`, and an optional reasoning `effort` per entry. Anything worth keeping but not running
moves to `models_off` in the same file, and `--model <id>` runs a single entry without editing
either list. The entry format is spelled out under [A model](#a-model).

| flag                 |                                                                        |
| -------------------- | ---------------------------------------------------------------------- |
| `--model <id>`       | run one entry from the config instead of every one                     |
| `--file a,b`         | dataset files to run, comma-separated; default is every one            |
| `--limit N`          | first N cases                                                          |
| `--concurrency N`    | calls in flight at once, within one model (default 4)                  |
| `--run <run-id>`     | resume into an existing results directory instead of opening a new one |
| `--repeats N`        | same case N times — variance is a result too                           |
| `--today MM/DD/YYYY` | override the anchor date                                               |
| `--prompt v6`        | pick `prompts/<name>.txt`                                              |

`OPENAI_API_KEY` is needed even for Anthropic-only runs: fuzzy locations are graded with embeddings.

## What it covers

244 cases — **English 150 · German 50 · Spanish 44** — one JSON object per line in
`dataset/<lang>.jsonl`. Tags are report buckets, not a partition: a case can be `roundtrip`,
`flexible-date` and `fuzzy-location` at once, so the column below does not sum to 244.

| tag              | cases | what it stresses                                                             |
| ---------------- | ----: | ---------------------------------------------------------------------------- |
| `roundtrip`      |   153 | out and back, stated as a return date _or_ a length — never both             |
| `flexible-date`  |   116 | a window rather than a day: _"October or November"_, _"next 10 to 15 days"_  |
| `fuzzy-location` |   109 | places with no IATA code: _"beach towns in Southeast Asia"_, _"West Europe"_ |
| `oneway`         |    59 | nothing in the query points to a return                                      |
| `multi`          |    12 | two or more legs, each with its own date, in ascending order                 |
| `invalid-date`   |     7 | a date that cannot be honored — already past, or no such day                 |
| `invalid-others` |     3 | reads like a flight query but cannot become a search                         |

Ten seed cases carry no tag. Eleven cases expect `handle_invalid` — the win there is declining, not
inventing a plausible search out of a query that cannot support one.

Which fields a case asserts is the other half of coverage, since a grader is scored only where a case
speaks:

| asserted                                      |   cases |
| --------------------------------------------- | ------: |
| stay length, as `duration` / as `return_date` | 82 / 61 |
| `max_stops`                                   |      20 |
| `passengers`                                  |      16 |
| `connecting_airports`                         |       7 |
| `cabins`                                      |       6 |
| `max_price`                                   |       5 |
| `bags`                                        |       2 |

Date validity and trip shape assert nothing, so they are scored on every response that comes back as
a search at all.

## The 11 dimensions

`expect` holds assertions, not a reference output. A field it omits is not asserted, and that
dimension returns **not applicable** rather than pass or fail — not-applicable stays out of the
denominator, so no model is rewarded or punished for a field its case says nothing about. A case
passes only when every dimension it asserts passes.

| dimension                      | asserts                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `action` `search type`         | search the query or reject it; oneway · roundtrip · multi                               |
| `origin` `destination`         | the right airports — or, for places with no IATA code, the right region                 |
| `travel dates` `stay length`   | departure and return land inside the allowed window; the stay inside the allowed nights |
| `passengers` `cabin` `filters` | passengers, cabin, and the stops / price / bags / connection filters                    |
| `date validity`                | no departure before today, no return before departure, multi-city legs in order         |
| `trip shape`                   | leg count matches the search type; `return_date` and `duration` never both set          |

The last two take no expected value. They hold for any valid search, so every search is scored on
them — and they read the raw response, never a normalized one.

## Grading that isn't brittle

- **Dates are windows.** `"03/15/26"` demands that day. `"10/01/26-10/31/26"` accepts any day in
  October, because _"somewhere warm in October"_ has no single right answer.
- **Durations are ranges.** `"7"` is exactly a week, `"3-5"` accepts 3 to 5 nights, `"21-"` is three
  weeks or more.
- **A stay stated either way is the same stay.** `duration` and `return_date` encode one fact, so
  whichever one the model leaves out is derived from the other before the comparison — a case
  expecting `"7"` is answered by a return date a week after departure. Deriving needs a departure
  pinned to a single day; a trip without one is compared as it stands.
- **Several airports can be right.** `{"any_code": ["ORD", "CHI", "MDW"]}` — Chicago is Chicago.
- **Regions are compared by meaning.** _"west europe"_, _"beach towns in Southeast Asia"_ have no IATA
  code, so `names` lists the spellings the case accepts — including the query's own wording — and every
  returned name has to match one of them outright or by embedding cosine (≥ `similarity_threshold`, 0.72
  today). The list is alternatives, like `any_code`: it does not ask for one location per name, so _"east
  or south east asia"_ is answered by two names or by one that writes both. Names that already match
  exactly never touch the network.

## A case

```json
{
    "id": "rt-bhx-pak-3wk-plus",
    "lang": "en",
    "text": "birmingham to lahore or islamabad around 3 weeks or little more from 15 March",
    "tags": ["roundtrip", "flexible-date"],
    "expect": {
        "action": "get_tickets",
        "search_type": "roundtrip",
        "trips": [
            {
                "departure": { "any_code": ["BHX"] },
                "arrival": { "any_code": ["LHE", "ISB"] },
                "departure_date": "03/15/26",
                "duration": "21-"
            }
        ]
    }
}
```

One object per line in `dataset/<lang>.jsonl`; tags are optional, and the ones that mean something to
the report are defined in `src/dashboard/tags.json`. Expected dates are written against the anchor
date in `eval.config.json` (`"today": "01/01/2026"`), which is also the date the prompt is told is
today — change one and you change the other.

## A model

One entry per leaderboard row, so the same model at three reasoning efforts is three rows:

```json
{ "provider": "anthropic", "model": "claude-opus-5", "max_tokens": 1500, "effort": "high", "params": {} }
```

`params` reaches the vendor SDK untouched. Prices in the `pricing` block become a cost column;
`null` renders as `—`.

New vendor: add `src/providers/<vendor>.ts` — request, structured-output config, response parsing —
and register it in `ADAPTERS` in [src/run.ts](src/run.ts). Nothing outside that file knows which
vendor is being called.

## Layout

```
dataset/   en · de · es — *.jsonl, one case per line
prompts/   the system prompt under test
schema/    the JSON schema the model must fill
src/       run.ts · grade.ts · semantic.ts · providers/ · dashboard/ (+ tags.json)
docs/      hero.svg · badge.json — the README's score badge
results/   one directory per run (gitignored)
```

## License

[MIT](LICENSE)

<p align="center">
  <img src="docs/hero.svg" width="880" alt="A Spanish flight query parsed into a structured search spec, then scored on twelve grading dimensions">
</p>

<h1 align="center">flight-search-eval</h1>

<p align="center">
  An eval for the step <i>before</i> booking: turning one messy sentence into the flight search the traveler actually meant.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node 22+">
  <img src="https://img.shields.io/badge/OpenAI-412991?style=flat-square&logo=openai&logoColor=white" alt="OpenAI">
  <img src="https://img.shields.io/badge/Anthropic-D4A27F?style=flat-square&logo=anthropic&logoColor=white" alt="Anthropic">
  <img src="https://img.shields.io/badge/graders-12-6E56CF?style=flat-square" alt="12 graders">
  <img src="https://img.shields.io/badge/license-MIT-2F81F7?style=flat-square" alt="MIT license">
</p>

---

The search specification a model produces — origin, destination, dates, duration, passengers, cabin,
filters — decides which itineraries a traveler is ever shown. Grading it is grading whether the model
understood which flights they meant. Not a booking benchmark: τ-bench and friends cover what happens
after. This covers what happens before.

26 cases in English and Spanish, 12 independent graders, one adapter interface per vendor.

## Run it

```bash
npm install
cp .env.example .env   # OPENAI_API_KEY, ANTHROPIC_API_KEY
npm run eval
```

Each run writes `results/<run-id>/<model>.json` and a self-contained `index.html` leaderboard —
no server, just open it. Re-render any run with `npm run dashboard -- results/<run-id>`.

```bash
npm run eval -- --model claude-opus-5 --lang es --repeats 3
```

| flag | |
| --- | --- |
| `--model <id>` | run one entry from the config instead of every one |
| `--lang en\|es` | one dataset file |
| `--limit N` | first N cases |
| `--repeats N` | same case N times — variance is a result too |
| `--today MM/DD/YYYY` | override the anchor date |
| `--prompt v6` | pick `prompts/<name>.txt` |

`OPENAI_API_KEY` is needed even for Anthropic-only runs: fuzzy locations are graded with embeddings.

## The 12 dimensions

Every grader returns pass, fail, or **not applicable** — and not-applicable stays out of the
denominator, so no model is rewarded or punished for a field its case says nothing about.
A case passes only when every dimension it asserts passes.

| | asserts |
| --- | --- |
| `ACT` `TYPE` | search vs. `handle_invalid`; oneway / roundtrip / multi |
| `ORIG` `DEST` | the right airports — or, for places with no IATA code, the right region |
| `DATE` `DUR` | departure and return land inside the allowed window; the stay inside the allowed nights |
| `PAX` `CABIN` `FILT` | passengers, cabin, and the stops / price / bags / connection filters |
| `NOINV` | nothing invented — every param the case does not assert came back `null` |
| `SANE` | no departure before today, no return before departure, multi-city legs in order |
| `SHAPE` | trip count matches the search type; `return_date` and `duration` never both set |

The last three take no expected value. They hold for any valid search, so every case is scored on them.

## Grading that isn't brittle

- **Dates are windows.** `"03/15/26"` demands that day. `"10/01/26-10/31/26"` accepts any day in
  October, because *"somewhere warm in October"* has no single right answer.
- **Durations are ranges.** `"7"` is exactly a week, `"3-5"` accepts 3 to 5 nights, `"21-"` is three
  weeks or more.
- **Several airports can be right.** `{"any_code": ["ORD", "CHI", "MDW"]}` — Chicago is Chicago.
- **Regions are compared by meaning.** *"west europe"*, *"beach towns in Southeast Asia"* have no IATA
  code, so returned names are paired against expected ones by embedding cosine (≥ 0.80), one-to-one and
  order-free. Names that already match exactly never touch the network.
- **Closed world.** A case that never mentions bags expects `bags: null`. Helpfully inventing
  `checked: 1` is a failure, not a bonus.

## A case

```json
{"id": "rt-bhx-pak-3wk-plus", "lang": "en",
 "text": "birmingham to lahore or islamabad around 3 weeks or little more from 15 March",
 "tags": ["roundtrip", "flexible-date"],
 "expect": {"action": "get_tickets", "search_type": "roundtrip",
   "trips": [{"departure": {"any_code": ["BHX"]},
              "arrival": {"any_code": ["LHE", "ISB"]},
              "departure_date": "03/15/26", "duration": "21-"}]}}
```

One object per line in `dataset/<lang>.jsonl`; tags are the report buckets defined in
`dataset/tags.json`. Expected dates are written against the anchor date in `eval.config.json`
(`"today": "01/01/2026"`), which is also the date the prompt is told is today — change one and you
change the other.

## A model

One entry per leaderboard row, so the same model at three reasoning efforts is three rows:

```json
{ "provider": "anthropic", "model": "claude-opus-5", "max_tokens": 1500, "effort": "high", "params": {} }
```

Park an entry by moving it to `models_off`. `params` reaches the vendor SDK untouched. Prices in the
`pricing` block become a cost column; `null` renders as `—`.

New vendor: add `src/providers/<vendor>.ts` — request, structured-output config, response parsing —
and register it in `ADAPTERS` in [src/run.ts](src/run.ts). Nothing outside that file knows which
vendor is being called.

## Layout

```
dataset/   *.jsonl cases + tags.json
prompts/   the system prompt under test
schema/    the JSON schema the model must fill
src/       run.ts · grade.ts · semantic.ts · providers/ · dashboard/
results/   one directory per run (gitignored)
```

## License

[MIT](LICENSE)

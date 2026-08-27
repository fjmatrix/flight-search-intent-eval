# flight-search-eval — Implementation Plan

**Airline ticket search eval.** Scores how well a model turns a traveler's request into the
intended flight search.

The model's output is a search specification: origin, destination, dates, duration, passengers,
cabin, filters. That specification determines which itineraries a traveler is shown — so
grading it is grading whether the model understood which flights they meant.

Not a booking benchmark. τ-bench covers post-booking support operations against a mocked
reservation database. This covers what happens before that.

---

## Scope

Natural-language query → structured search parameters. Model API only. No provider calls,
no live fares, no itinerary fetching.

Three model vendors — OpenAI, Anthropic, Google — behind one adapter interface. Same prompt,
same dataset, same graders across all three. Vendor differences live in the adapters and
nowhere else.

---

## Providers

One file per vendor. Each owns three things and exposes nothing else: request construction,
schema/tool configuration, and response parsing.

### The interface

```ts
// src/providers/types.ts

type JsonSchema = Record<string, unknown>

interface ModelRequest {
  system: string          // prompt text, {{todaysDate}} already substituted
  user: string            // the case's query text
  schema: JsonSchema      // vendor-neutral schema/search-input.json
  model: string
  maxTokens: number
  params: Record<string, unknown>   // vendor-specific knobs, passed through from config
}

interface TokenUsage {
  input: number
  output: number
  reasoning: number | null     // null when the vendor does not report it
  cache_read: number
  cache_write: number
  total: number                // vendor-reported; never summed by hand
  raw: unknown                 // the vendor's usage object, verbatim
}

type RunStatus = "ok" | "refusal" | "incomplete" | "parse_error" | "schema_error" | "api_error"

interface ModelResponse {
  output: unknown | null       // parsed object, or null when status !== "ok"
  status: RunStatus
  error?: string
  raw_text?: string            // what came back when parsing failed
  usage: TokenUsage
  latency_ms: number
  attempts: number
  meta: { model_id: string; response_id?: string; finish_reason?: string }
}

interface Provider {
  name: "openai" | "anthropic" | "gemini"
  call(req: ModelRequest): Promise<ModelResponse>
  toProviderSchema(schema: JsonSchema): unknown   // exported for the parity check
}
```

`run.ts` sees only `Provider`. It never branches on vendor.

A one-line registry — `{ openai, anthropic, gemini }` keyed by name — because config selects a
vendor by string. The graders stay registry-free; that rule was about grading, not dispatch.

### `openai.ts`

- **Request** — **Chat Completions**, not the Responses API. `constructPayload` posts to
  `/v1/chat/completions` with `response_format`, and an eval that measures a different API
  surface than production ships is measuring the wrong thing. Prompt as the `system` message,
  case text as the `user` message.
- **Schema** — `response_format` = `{ type: "json_schema", json_schema: { name:
  "flight_search_result", strict: true, schema } }`. `strict` requires
  `additionalProperties: false` and every property listed in `required`; optional fields are
  expressed as nullable unions, not by omission. `schema/search-input.json` already satisfies
  this — it is the object production sends — so `toProviderSchema` is the identity and a
  violation surfaces as a 400, never as a silent edit.
- **Parsing** — `choices[0].message.content`, `JSON.parse`. `message.refusal` maps to
  `status: "refusal"`; `finish_reason` of `length` or `content_filter` maps to
  `status: "incomplete"`. Neither is a failed grade.
- **Usage** — `prompt_tokens` → `input`, `completion_tokens` → `output`, `total_tokens`,
  `prompt_tokens_details.cached_tokens` → `cache_read`,
  `completion_tokens_details.reasoning_tokens` → `reasoning`. No cache-write counter exists
  on this surface — OpenAI caching is automatic — so `cache_write` is always 0.
- **Knobs** — `temperature`, `seed`, `reasoning_effort`, `max_completion_tokens`.
  `seed` is best-effort, not a guarantee.

### `anthropic.ts`

- **Request** — Messages API via `@anthropic-ai/sdk`. Prompt as top-level `system`, case text
  as a single user message.
- **Schema** — `output_config: { format: { type: "json_schema", schema } }`. Takes the raw
  JSON Schema directly, so no translation step. (Strict tool use is the alternative; the
  output here is a document, not a call, so `output_config` is the honest shape.)
- **Parsing** — the response's text block is the JSON object. `stop_reason: "refusal"` →
  `status: "refusal"`; read `stop_details.category` into `error`.
- **Usage** — `input_tokens`, `output_tokens`, `cache_read_input_tokens` → `cache_read`,
  `cache_creation_input_tokens` → `cache_write`. No `total_tokens` field; set
  `total = input + output` and note it, since cache tokens are billed at different rates.
- **Knobs** — `output_config.effort` (`low`…`max`). **No `temperature`, no `top_p`, no `seed`**
  on Opus 5 / Sonnet 5 / Opus 4.7+ — sending them returns a 400. Thinking is adaptive and on
  by default on Opus 5, which moves output tokens a lot; set `effort` explicitly and record it,
  or the token comparison against the other two vendors is meaningless.

### `gemini.ts`

- **Request** — `@google/genai`, `generateContent`. Prompt as `systemInstruction`.
- **Schema** — `responseMimeType: "application/json"` plus `responseSchema`. This is the
  binding constraint on the whole exercise: Gemini's schema dialect is an OpenAPI 3.0 subset,
  not JSON Schema. `additionalProperties`, `$schema`, and several `format` values are not
  accepted; field order is expressed with `propertyOrdering`. `toProviderSchema` does the
  translation and is the most likely source of a bug that looks like a model failure.
- **Parsing** — candidate text → `JSON.parse`. A `finishReason` other than `STOP`
  (`SAFETY`, `MAX_TOKENS`) maps to a non-`ok` status.
- **Usage** — `usageMetadata`: `promptTokenCount` → `input`, `candidatesTokenCount` → `output`,
  `thoughtsTokenCount` → `reasoning`, `cachedContentTokenCount` → `cache_read`,
  `totalTokenCount` → `total`.
- **Knobs** — `temperature`, `seed`, `thinkingConfig`.

### The parity problem, stated plainly

Same prompt and same dataset make the comparison fair. Same *schema enforcement* does not
survive contact with three vendors: OpenAI constrains decoding under `strict`, Anthropic
constrains it under `output_config`, and Gemini validates against a schema that cannot express
the original.

So: `npm run eval -- --check-schema` renders `schema/search-input.json` through all three
`toProviderSchema` functions and diffs the results, listing every construct that did not
survive. It runs at the start of every eval and the summary is written into `results.json`.
A dashboard that shows Gemini losing on `gradeFilters` while its schema silently dropped a
constraint is worse than no dashboard.

Field names above are pinned to SDK versions and get verified against the installed SDK when
each adapter is written.

---

## Token and cost accounting

Every run records its `TokenUsage`, including failed runs — a response that failed to parse
still burned tokens, and that is frequently where the tokens went. Retries are counted in
`attempts` and their tokens are included; retried spend is real spend.

**`results.json` stores tokens, never dollars.** Prices change and old runs still need correct
math. `eval.config.json` carries a per-model price table (per MTok: `input`, `output`,
`cache_read`, `cache_write`) and the dashboard multiplies at render time. Correcting a price
is an edit and a refresh, not a re-run.

Aggregates: per case, per language, per provider, per run. The dashboard gets tokens-in,
tokens-out, reasoning tokens, cost, and cost-per-case — the last one being the number that
actually decides which model ships.

Prompt caching is off for now. The system prompt is identical across every case, so enabling it
would cut cost substantially; it is deferred only because `cache_read` / `cache_write` have to
be broken out in the report before the cost math can absorb them. The fields exist from day one
so turning it on later is a config change.

---

## Grading

One function per dimension. Uniform signature, plain functions, no registry.

```ts
type Grade = boolean | null          // null = not applicable to this case

type Grader = (actual: SearchInput, expect: Expect, ctx: { today: string }) => Grade
```

`ctx.today` carries the same date injected into the prompt. `gradeDateRange` cannot resolve
`"+1 month"` without it, and `gradeRestraint` reads the whole `expect` object rather than one
field — so the signature takes both, rather than pretending a two-argument form is enough.

| Function | Passes when |
|---|---|
| `gradeAction` | `result.action` matches expected (`get_tickets` / `handle_invalid`) |
| `gradeSearchType` | `search_type` matches expected |
| `gradeOrigin` | Per leg, departure codes match the expected set — order-insensitive, any listed alternative accepted |
| `gradeDestination` | Same, for arrival |
| `gradeDateRange` | `departure_date` and `return_date` match the expectation resolved against `ctx.today`, within the case's tolerance |
| `gradeDuration` | `duration` matches expected |
| `gradePassengers` | `passengers` object matches expected |
| `gradeCabin` | `cabins` matches expected |
| `gradeFilters` | `max_stops`, `max_price`, `flight_duration`, `connecting_airports`, `bags` all match |
| `gradeRestraint` | Every field in the case's `must_be_null` is actually `null` |
| `gradeSchema` | The returned object validates against `schema/search-input.json` |

**Returning `null`.** A grader returns `null` when the case's `expect` has nothing to say about
that dimension. Not-applicable is excluded from the denominator — never counted as a pass.
This is the one rule that keeps the percentages honest.

**Not applicable is not the same as not attempted.** A run whose `status` is not `ok` produces
no grades at all: it lands in an error rate reported beside the pass rates, not as a column of
`false`. An expired key scoring 0% on every dimension is the failure mode this prevents.

**`gradeSchema` is back.** The original plan dropped it because `strict: true` made it
constant at 1.00 — true of OpenAI alone. Anthropic's constrained decoding and Gemini's
schema-subset validation are different mechanisms with different failure modes, so the column
measures something real again. Expect it to be 1.00 for OpenAI and Anthropic and to be where
Gemini's translated-schema problems first show up.

**Still deliberately absent:** *business rules* (`validateAiSearchInput`) — overlaps search
type, dates, and passengers.

---

## Files

```
flight-search-eval/
├─ PLAN.md
├─ SOURCES.md                    # provenance for every copied file
├─ package.json
├─ .env.example                  # OPENAI_API_KEY= ANTHROPIC_API_KEY= GEMINI_API_KEY=
├─ eval.config.json              # provider blocks, prompt, repeats, price table
├─ prompts/
│  └─ v6.txt                     # {{todaysDate}} placeholder; variants are new files
├─ schema/
│  └─ search-input.json          # copied from flightcat_worker
├─ dataset/
│  ├─ en.jsonl                   # one case per line
│  └─ es.jsonl
├─ src/
│  ├─ providers/
│  │  ├─ types.ts                # ModelRequest, ModelResponse, TokenUsage, Provider
│  │  ├─ retry.ts                # shared backoff, so `attempts` means one thing
│  │  ├─ openai.ts
│  │  ├─ anthropic.ts
│  │  ├─ gemini.ts
│  │  └─ index.ts                # name → Provider
│  ├─ types.ts                   # Case, Expect, AiSearchInput, ParsedResult
│  ├─ grade.ts                   # the eleven graders
│  ├─ run.ts                     # load → call → grade → write
│  └─ dashboard.ts               # results.json → index.html
└─ results/
   └─ 2026-08-26T2210Z/
      ├─ results.json
      └─ index.html
```

Dependencies: `tsx`, `typescript`, and the three vendor SDKs. The original plan called for raw
`fetch` and no SDKs — that was the right call for one vendor and the wrong one for three. Each
adapter is vendor-specific code either way, so hand-rolling the wire format buys no symmetry;
it only costs typed usage fields, retry/backoff, and error classes that already exist. Symmetry
lives at the `Provider` interface, which is the only place it was ever worth having.

---

## Config

Vendor knobs are not shared. `temperature` and `seed` are meaningless on current Anthropic
models — they return a 400 — so a flat top-level `temperature` would be a lie in one of three
cases. Per-provider blocks instead:

```json
{
  "prompt": "v6",
  "repeats": 3,
  "max_tokens": 4096,
  "concurrency": 4,
  "providers": {
    "openai":    { "model": "gpt-5.6-terra", "params": { "temperature": 0, "seed": 10 } },
    "anthropic": { "model": "claude-opus-5", "params": { "effort": "medium" } },
    "gemini":    { "model": "gemini-3-pro",  "params": { "temperature": 0, "seed": 10 } }
  },
  "pricing": {
    "claude-opus-5": { "input": 5.00, "output": 25.00, "cache_read": 0.50, "cache_write": 6.25 }
  }
}
```

---

## Copied from flightcat_worker

`constructPayload` bundles prompt text, model, temperature, seed, and response schema into one
function. Split on copy so model and prompt become config edits:

- **`schema/search-input.json`** — `searchInputJsonSchema` plus the `get_tickets` /
  `handle_invalid` wrapper. Stays JSON; no compilation needed. This is the vendor-neutral
  form — each adapter translates from it, and none of them mutate it.
- **`prompts/v6.txt`** — the system prompt text with `{{todaysDate}}`. A prompt variant is a
  new file plus a config line.
- **`eval.config.json`** — as above.

Provenance lives in `SOURCES.md`, not in per-file headers: `prompts/v6.txt` is byte-sensitive
(a header becomes part of the prompt) and `schema/search-input.json` is sent to the API verbatim
under `strict: true`, where an unrecognized `$comment` key is a risk not worth taking. Both were
extracted from the Worker source programmatically rather than transcribed, and the prompt is
verified byte-exact.

These will drift from the deployed Worker; a CI check can come later.

---

## What the model returns

The schema wraps the search in an envelope, so graders read through it:

```
{ result: { action: "get_tickets",    params: AiSearchInput } }
{ result: { action: "handle_invalid", reason: "off_topic" | "invalid_other" } }
```

`AiSearchInput` puts the per-leg fields inside `trips[]` — `departure[]`, `arrival[]`,
`departure_date`, `return_date`, and `duration` are **per trip**, not top-level. Only
`search_type`, `passengers`, `cabins`, `max_stops`, `max_price`, `flight_duration`,
`connecting_airports`, and `bags` sit at the top. `search_type` is `oneway | roundtrip | multi`.

Dates come back as `MM/DD/YY`, or `MM/DD/YY-MM/DD/YY` for an approximate date; `duration` is a
string of days, `"7"` or `"3-5"`. The date injected into the prompt is `MM/DD/YYYY` — a
different format from the one the model is asked to emit. `gradeDateRange` has to parse both.

Validating the envelope is vendor-neutral, so `run.ts` does it and sets `schema_error`;
adapters return the parsed JSON exactly as the model produced it and never inspect its shape.

---

## Dataset — JSONL

One case per line. Shown expanded here; it is one line in the file.

```json
{
  "id": "rt-duration-01",
  "lang": "en",
  "text": "round trip from Chicago to Tokyo next month for a week, 2 adults",
  "expect": {
    "action": "get_tickets",
    "search_type": "roundtrip",
    "passengers": { "adults": 2, "children": 0, "infants": 0 },
    "trips": [
      {
        "departure":      { "any_code": ["ORD", "CHI"] },
        "arrival":        { "any_code": ["TYO", "NRT", "HND"] },
        "departure_date": { "relative": "+1 month", "tolerance_days": 3 },
        "duration":       "7"
      }
    ],
    "must_be_null": ["cabins", "max_stops", "max_price", "flight_duration",
                     "connecting_airports", "bags"]
  }
}
```

`expect.trips` mirrors the schema's `trips[]` positionally, so multi-city needs no separate
shape — it is the same expectation with three entries. This corrects an earlier draft that had
`origin`, `destination`, and `duration` at the top level; they are per-trip in the contract, and
graders that read them from the top would have been wrong on every case.

Five rules:

1. **Absent means don't care** — that grader returns `null`. Explicit `null` means must be null.
   Never assert a field the query didn't determine.
2. **Alternatives, not single answers.** Tokyo is TYO, NRT, or HND; all three are correct.
3. **Dates are relative expressions**, resolved against `ctx.today` — the same date passed to
   the prompt. Frozen date strings rot within weeks.
4. **Types mirror the schema exactly.** `duration` is `"7"` because the schema says string.
   Graders compare, they do not coerce; a coercion is a bug hidden in the scoring.
5. **`must_be_null` names top-level `params` fields only.** Trip-level nulls belong to
   `gradeDateRange` and `gradeDuration`. An unrecognized field name is a load-time error with
   a `file:line`, not a quiet failure against every model — which is what a typo would
   otherwise look like on the dashboard.

**Tolerance** is the absolute difference in days between the resolved expected `departure_date`
and the actual one, applied independently to `return_date`. Keep it at 0 for explicit dates and
1–3 for vague ones. The `31` in the original draft would have passed nearly any date in the
month and quietly turned `gradeDateRange` green.

`es.jsonl` reuses the same `id` values so the two languages line up in the dashboard.

---

## Output

### `results.json`

```json
{
  "run_id": "2026-08-26T2210Z",
  "today": "2026-08-26",
  "config": { "prompt": "v6", "repeats": 3,
              "providers": { "anthropic": { "model": "claude-opus-5",
                                            "params": { "effort": "medium" } } } },
  "schema_parity": { "openai": "exact", "anthropic": "exact",
                     "gemini": ["dropped additionalProperties", "dropped format: uri"] },
  "cases": [
    {
      "id": "rt-duration-01", "lang": "en",
      "text": "round trip from Chicago to Tokyo next month for a week, 2 adults",
      "runs": [
        { "provider": "anthropic",
          "status": "ok",
          "grades": { "gradeAction": true, "gradeOrigin": true,
                      "gradeDestination": false, "gradeCabin": null },
          "actual": { },
          "usage": { "input": 1840, "output": 96, "reasoning": 0,
                     "cache_read": 0, "cache_write": 0, "total": 1936, "raw": { } },
          "latency_ms": 812, "attempts": 1 }
      ]
    }
  ]
}
```

`today` is recorded because without it a rerun of the graders against an old results file
resolves `"+1 month"` from a different anchor and silently regrades every date case.

Raw model output kept per run. Without it the dashboard can show a red cell but not why.
The file grows with cases × repeats × providers; at ~20 cases it is a few MB, which is fine.

### `index.html`

Self-contained, no network. The results JSON is inlined; opening the file is the whole workflow.

- **Header** — providers and models, prompt version, repeats, timestamp, `today`, and the
  schema-parity summary when anything was dropped.
- **Summary row** — per provider: overall pass rate, one figure per dimension, error rate,
  total tokens, total cost, cost per case. This is the screenshot.
- **Matrix** — one row per case per language, one column per grader, grouped by provider.
  Green pass, red fail, grey not-applicable, hatched error. With repeats > 1 the cell reads
  `2/3` and anything short of unanimous is marked — that is the variance signal, no statistics
  needed.
- **Row expands** to show the query text, what was expected, what each model returned, and the
  token counts for that call, with failing fields highlighted. This is what makes it usable
  while iterating on the prompt.
- **Filter by language and provider**, and sort columns by pass rate.

---

## Running

```sh
npm run eval                                  # all providers, all cases, config defaults
npm run eval -- --provider anthropic
npm run eval -- --provider openai,anthropic   # paired comparison, identical cases
npm run eval -- --lang en
npm run eval -- --repeats 3
npm run eval -- --model gpt-5.4-mini          # only valid with a single --provider
npm run eval -- --prompt v7
npm run eval -- --check-schema                # parity report only, no model calls
```

`--check-schema` costs nothing and answers "is this comparison honest" before spending on a run.

Calls run at `concurrency` (default 4) with exponential backoff on 429 and 5xx. 20 cases ×
3 repeats × 3 providers is 180 calls; unbounded that is a rate-limit wall, and a retried call
still costs tokens, so `attempts` is recorded.

---

## Milestones

**M1 — the loop. Done.**
`providers/types.ts`, `providers/retry.ts`, `providers/openai.ts`, `run.ts`, and three graders
(`gradeAction`, `gradeSearchType`, `gradeRestraint`). Four English cases. Writes `results.json`
with usage recorded, prints a summary to the console. No dashboard — prove the call-and-grade
loop before building the view.

Verified against a local mock of the Chat Completions endpoint, which exercises the whole path
without spending anything: mixed pass/fail/not-applicable grading, `--repeats 3`, transient
5xx retried to success, exhausted retries recorded as `api_error` with `attempts: 3`, a
malformed envelope recorded as `schema_error` **with its tokens still counted**, and a mistyped
`must_be_null` field rejected at load with a `file:line`. Total API failure prints `—` per
grader, never 0% — the property the `status` field exists for.

`--check-schema` and `--dry-run` run without credentials.

**M2 — full graders and dataset.** ← next
The other eight graders. 10 English + 10 Spanish cases.

The date graders are the work here: the prompt is handed `MM/DD/YYYY` while the model emits
`MM/DD/YY` and `MM/DD/YY-MM/DD/YY` ranges, so resolving `"+1 month"` against `ctx.today` and
comparing within tolerance means parsing two formats and a range on each side.

**M3 — the other two adapters.**
`anthropic.ts`, `gemini.ts`, `toProviderSchema`, and `--check-schema`. Before the dashboard,
not after: a dashboard designed against one provider's results gets rebuilt the moment a
second one lands, and the schema-parity output is a thing the dashboard has to display.

**M4 — dashboard.**
`dashboard.ts`. Reads `results.json`, writes `index.html`, including token and cost columns
and the parity banner.

**M5 — configurability.**
Repeats, model override, prompt variants. Two prompt files, one run, paired comparison on
identical cases.

---

## Open

- **Prompt fairness across vendors.** The same prompt text is the fair comparison and also the
  handicap: `v6` was tuned against OpenAI. A per-vendor prompt variant would measure each
  vendor at its best but stop being a controlled comparison. Run both and report both.
- **Prompt caching.** Off for now; the fields are logged so it is a config change later.
- **Prompt drift** from the deployed Worker. Header comment now, CI check later.
- **Scope of intent.** Cases must compile to checkable expectations. "Somewhere nice for a
  honeymoon" does not. Worth stating in the README.

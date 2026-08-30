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
  cached: number
  total: number                // vendor-reported; never summed by hand
}

type RunStatus = "ok" | "refusal" | "incomplete" | "error"

interface ModelResponse {
  output: unknown              // parsed JSON, or null when status !== "ok"
  status: RunStatus
  error?: string
  usage: TokenUsage
  latency_ms: number
}

interface Provider {
  name: string
  call(req: ModelRequest): Promise<ModelResponse>
}
```

`run.ts` sees only `Provider`. It never branches on vendor.

No registry while there is one adapter — `run.ts` imports it directly. A `{ openai, anthropic,
gemini }` map earns its place in M4, when config actually has to pick between them.

### `openai.ts`

- **Request** — Responses API. Prompt as `instructions`, case text as `input`.
- **Schema** — `text.format` = `{ type: "json_schema", name: "flight_search_result",
  strict: true, schema }`. `strict` is assumed everywhere downstream: an `ok` response is
  taken to match the schema without re-validation, which is what lets `run.ts` cast rather
  than parse. `schema/search-input.json` already satisfies strict's constraints — it is the
  object production sends — so a violation surfaces as a 400, never as a silent edit.
- **Parsing** — `response.output_text`, `JSON.parse`. `status: "incomplete"` carries
  `incomplete_details.reason`; a `refusal` content part maps to `status: "refusal"`. Neither
  is a failed grade.
- **Usage** — `input_tokens`, `output_tokens`, `total_tokens`,
  `input_tokens_details.cached_tokens` → `cached`,
  `output_tokens_details.reasoning_tokens` → `reasoning`.
- **Knobs** — `temperature`, `reasoning: { effort }`, `max_output_tokens`.

**`seed` does not exist on this surface.** It is a Chat Completions parameter, and the Worker
pins `seed: 10`; the Responses API has no equivalent (verified against the installed SDK).
Determinism here rests on `temperature: 0` alone, so run-to-run variance that the Worker
suppresses is visible in this eval. That is arguably the more honest measurement, but it is a
difference from production, and `repeats` is how it gets quantified.

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

The consequence is real — a dashboard showing Gemini losing on `gradeFilters` while its schema
silently dropped a constraint is worse than no dashboard — but the machinery for detecting it
was built too early. With one adapter whose translation is the identity, a parity checker
compares a schema to itself and reports "exact" forever.

It lands in M4, alongside the first `toProviderSchema` that actually transforms anything, and
the honest form is probably a one-time report at startup rather than a per-case grader.

---

## Token and cost accounting

Every run records its `TokenUsage`, including failed runs — a refusal or a truncated response
still burned tokens, and that is frequently where the tokens went. Only a call that never
reached the model reports zero.

**`results.json` stores tokens, never dollars.** Prices change and old runs still need correct
math. `eval.config.json` carries a per-model price table (per MTok: `input`, `output`,
`cache_read`, `cache_write`) and the dashboard multiplies at render time. Correcting a price
is an edit and a refresh, not a re-run.

Aggregates: per case, per language, per provider, per run. The dashboard gets tokens-in,
tokens-out, reasoning tokens, cost, and cost-per-case — the last one being the number that
actually decides which model ships.

OpenAI caches automatically, so `cached` is reported from day one; Anthropic's opt-in cache
adds a written-vs-read distinction, and `TokenUsage` grows a field when that lands in M4. The
system prompt is identical across every case, so the savings are worth having once the cost
math can account for both rates separately.

---

## Grading

One function per dimension. Uniform signature, plain functions, no registry.

```ts
type Grade = boolean | null          // null = not applicable to this case

type Grader = (actual: SearchInput, expect: Expect, ctx: { today: string }) => Grade
```

`ctx.today` carries the same date injected into the prompt. `gradeDateSanity` needs it to know
which departures are in the past, and `gradeNoInventedParams` reads the whole `expect` object
rather than one field — so the signature takes both, rather than pretending a two-argument form
is enough. A grader that needs neither declares fewer parameters and stays assignable.

| Function | Passes when |
|---|---|
| `gradeAction` | `result.action` matches expected (`get_tickets` / `handle_invalid`) |
| `gradeSearchType` | `search_type` matches expected |
| `gradeOrigin` | Per leg, departure codes match the expected set — order-insensitive, any listed alternative accepted; or, for a fuzzy case, the returned name clears the similarity threshold |
| `gradeDestination` | Same, for arrival |
| `gradeDateRange` | `departure_date` and `return_date` land inside the window the case states |
| `gradeDuration` | `duration` matches expected |
| `gradePassengers` | `passengers` object matches expected |
| `gradeCabin` | `cabins` matches expected |
| `gradeFilters` | `max_stops`, `max_price`, `flight_duration`, `connecting_airports`, `bags` all match |
| `gradeNoInventedParams` | Every omitted nullable top-level or trip field is actually `null` |
| `gradeDateSanity` | Every departure is on or after today; return is on or after departure; `multi` departures strictly increase |
| `gradeTripShape` | No trip sets both `return_date` and `duration`; `oneway` sets neither; trip count matches `search_type` |

**Returning `null`.** A grader returns `null` when the case's `expect` has nothing to say about
that dimension. Not-applicable is excluded from the denominator — never counted as a pass.
`gradeNoInventedParams` separately enforces that an omitted nullable field stays null, so
not-applicable never gives the model permission to invent a value. This keeps the per-dimension
percentages honest without weakening the whole-case result.

**Not applicable is not the same as not attempted.** A run whose `status` is not `ok` produces
no grades at all: it lands in an error rate reported beside the pass rates, not as a column of
`false`. An expired key scoring 0% on every dimension is the failure mode this prevents.

**The last two take no `expect` at all.** They are invariants of any valid search, so they
grade every `get_tickets` case for free and return `null` only for `handle_invalid`. They exist
because three separate layers fail to enforce them:

| Rule | JSON Schema | `validateAiSearchInput` | Downstream |
|---|---|---|---|
| Departure not in the past | no | no | **silently clamps to tomorrow** (`prepareDate`) |
| Not both `return_date` and `duration` | prose only | no | **`return_date` wins, `duration` dropped** |

Both are invisible in production — no error, no log, just a different search than the traveler
asked for. That is precisely what makes them worth a column here. The eval calls the model API
directly and never runs `prepareDate`, so it grades the raw answer rather than the repaired one.

The exclusivity rule is also the counterexample to leaning on `strict: true`. Constrained
decoding guarantees the *shape*; it says nothing about two fields being mutually exclusive.
Expressing that would mean restructuring `trips.items` into an `anyOf` of three variants, which
the Worker does not do — so the model is free to emit both, and does not get corrected.

Note what is **not** a rule: a roundtrip with `return_date` and `duration` both null is
legitimate. Production falls back to `DEFAULT_ROUNDTRIP_DURATION`. The rule is "never both",
not "exactly one".

**Still deliberately absent: schema conformance.** `strict: true` is assumed, so the column
would read 1.00 and measure the API rather than the model. Gemini is the case that could
change this — its schema dialect cannot express the contract exactly — but that is an M4
question, and the answer there is more likely a one-time translation report than a per-case
grader.

**Still deliberately absent:** *business rules* (`validateAiSearchInput`) — overlaps search
type, dates, and passengers.

---

## Fuzzy locations

Some queries name a region, not an airport — "west Europe", "Texas", "nice beach towns in Asia".
No IATA code means any of them, so the model returns `code: "n/a"` with the traveler's words in
`name`, and production expands that in a second model call. `codesMatch` compares codes, `"n/a"`
is not one, so those cases currently grade as location failures however well they were handled.

Nothing about the model's contract changes. The schema already says "use `n/a` when unavailable"
and `v6` stays byte-exact; the change is the dataset and the two location graders.

### The expectation

```ts
interface LocationExpect {
  any_code?: string[]
  /** The intended location has no IATA code. Absent means false. */
  fuzzy?: boolean
  /** What the model's `name` is compared against, when fuzzy. */
  name?: string
}
```

```json
"departure": { "any_code": ["BOS"] },
"arrival":   { "fuzzy": true, "name": "western Europe" }
```

The twenty existing cases need no edits — absent `fuzzy` is `false`, which is what they already
mean.

| `expect` | model's `code` | result |
|---|---|---|
| `any_code` | an IATA code | unchanged code match |
| `any_code` | `"n/a"` | fail — `"n/a"` is in no `any_code` list, so this already works |
| `fuzzy` | `"n/a"` | embed both names, cosine, `>= 0.80` |
| `fuzzy` | an IATA code | fail — a region collapsed into one airport |

### `src/semantic.ts`

The whole file:

```ts
export interface GradingConfig {
  embedding_model: string
  similarity_threshold: number
}

function cosineSimilarity(a: number[], b: number[]): number { /* dot / (magA * magB) */ }

/** Embeds both names and reports whether they clear the configured threshold. */
export async function isSimilar(
  expected: string,
  actual: string,
  config: GradingConfig,
): Promise<boolean> {
  const result = await getClient().embeddings.create({
    model: config.embedding_model,
    input: [expected, actual],
  })

  const score = cosineSimilarity(result.data[0]!.embedding, result.data[1]!.embedding)
  return score >= config.similarity_threshold
}
```

Model and threshold live in `eval.config.json` under `grading`, and the block is copied into
`results.json` — for the same reason `today` is. Swapping the embedding model rescores every
fuzzy case at once, so a run that does not say which ruler it used cannot be compared to another.

### Measured, not guessed

`text-embedding-3-small`, the six pairs the threshold exists to separate:

| expected | actual | score | want |
|---|---|---|---|
| beach towns in Asia | Nice beach towns in Asia | **0.928** | pass |
| western Europe | West Europe | **0.886** | pass |
| Texas | Texas, USA | **0.600** | pass ✗ |
| western Europe | Eastern Europe | **0.613** | fail |
| Texas | Dallas | **0.426** | fail |
| beach towns in Asia | Asia | **0.427** | fail |

0.80 holds for multi-word regions with room to spare, and the qualifier-dropping failure the
column exists to catch — "beach towns in Asia" answered with "Asia" — sits far below it at 0.427.

The one that does not work is short names. `Texas`/`Texas, USA` scores 0.600, *below*
`western Europe`/`Eastern Europe` at 0.613, so **no threshold separates them**: lowering the bar
far enough to accept the suffix also accepts the opposite half of a continent. Short strings carry
too little signal for cosine to rank them sensibly, and that is a property of the instrument, not
of a badly chosen number.

The fix is at the dataset level, not the threshold: for a one-word region, write `name` as the
model will actually say it, and accept that a case like "Texas" is asserting near-exact wording.
Multi-word regions — the ones this feature is actually for — have no such problem.

### `grade.ts`

`Grader` becomes `Grade | Promise<Grade>`, `gradeAll` gains an `await`, and `run.ts` gains one on
its `gradeAll` call. `gradeOrigin` and `gradeDestination` branch on `fuzzy`; the other ten graders
are untouched and stay synchronous.

```ts
async function locationsMatch(actual: AiSearchLocation[], expected: LocationExpect) {
  if (actual.length === 0) return false
  if (!expected.fuzzy) return actual.every((l) => expected.any_code!.includes(l.code))

  for (const location of actual) {
    if (location.code.trim().toLowerCase() !== 'n/a') return false
    if (!(await similar(expected.name!, location.name))) return false
  }
  return true
}
```

Making the graders async rather than pre-resolving the comparisons in `run.ts` is the cheaper
trade: it costs one `await` in `gradeAll` and buys back a whole layer of plumbing — no check
records, no context field, no pre-pass over the trips to find the pairs.

### Deliberately cut

- **The score is not recorded.** Re-tuning the threshold means re-running. Both compared strings are
  already in `results.json` — `expect` and the raw model output — so the pairs stay recoverable
  even when the numbers do not.
- **No embedding cache.** Every repeat of a fuzzy case pays one call. At `text-embedding-3-small`
  prices and a handful of fuzzy cases, that is not a number anyone will notice.
- **No error handling.** An embedding failure throws out of `gradeAll` and takes the run with it.
  A run is minutes long, so the fix is to re-run — but this is the cut with teeth, and the first
  one to reverse if the endpoint turns out flaky.

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
│  │  ├─ retry.ts                # written, not wired up — see Running
│  │  ├─ openai.ts
│  │  ├─ anthropic.ts
│  │  └─ gemini.ts
│  ├─ types.ts                   # Case, Expect, AiSearchInput, ParsedResult
│  ├─ semantic.ts                # cosine similarity over two embeddings
│  ├─ grade.ts                   # the twelve graders
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
  "today": "04/15/2027",
  "repeats": 3,
  "providers": {
    "openai":    { "model": "gpt-5.6-terra", "max_tokens": 800,
                   "params": { "temperature": 0, "reasoning": { "effort": "none" } } },
    "anthropic": { "model": "claude-opus-5", "max_tokens": 4096,
                   "params": { "effort": "medium" } },
    "gemini":    { "model": "gemini-3-pro",  "max_tokens": 4096,
                   "params": { "temperature": 0, "seed": 10 } }
  },
  "grading": {
    "embedding_model": "text-embedding-3-small",
    "similarity_threshold": 0.8
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

Adapters return the parsed JSON exactly as the model produced it and never inspect its shape.
`run.ts` does not re-validate the envelope either: `strict: true` already guarantees it, so
the result is cast, not parsed. That assumption is the reason this stays short — if a vendor
without constrained decoding is ever added, validation has to come back with it.

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
        "departure_date": "02/01/26-02/28/26",
        "duration":       "7"
      }
    ]
  }
}
```

`expect.trips` mirrors the schema's `trips[]` positionally, so multi-city needs no separate
shape — it is the same expectation with three entries. This corrects an earlier draft that had
`origin`, `destination`, and `duration` at the top level; they are per-trip in the contract, and
graders that read them from the top would have been wrong on every case.

Five rules:

1. **Absent nullable fields must be null.** Their dimension grader returns `null`, because the
   query did not assert a value, while `gradeNoInventedParams` fails if the model supplies one.
   Every `get_tickets` case must still provide `search_type`, `trips`, and each trip's departure
   and arrival because the response schema requires those fields to contain values.
2. **Alternatives, not single answers.** Tokyo is TYO, NRT, or HND; all three are correct.
   A location with no code at all — "Texas", "west Europe" — is asserted with
   `{ "fuzzy": true, "name": "..." }` and graded by similarity. See **Fuzzy locations**.
3. **Dates are literal, written against the pin.** A case's `departure_date` and `return_date`
   are `MM/DD/YY` or `MM/DD/YY-MM/DD/YY` strings — the shape the model answers in — and the
   model's date has to land inside them. A query naming a day gets that one day and accepts
   nothing else. A vague query gets the window it spans, and any answer inside passes, whether
   the model returns a single day or a narrower range:

   | Query | Expected, at pin 01/01/2026 |
   |---|---|
   | "on March 3" | `"03/03/26"` |
   | "next month" | `"02/01/26-02/28/26"` |
   | "in two weeks" | `"01/12/26-01/18/26"` |

   This replaces the `relative` / `next` / `date` forms an earlier draft resolved at grading
   time. Those computed the expected date with the same month-and-year arithmetic the model is
   being graded on — a second implementation standing behind the scoring, and one that made a
   case unreadable on its own: nothing in `{ "next": "03/02" }` says which year it will assert.
   A written-out window says exactly which answers count, and the case is the entire record of
   it. The cost is that the dataset is pinned; see **The pinned date**.
4. **Types mirror the schema exactly.** `duration` is `"7"` because the schema says string.
   Graders compare, they do not coerce; a coercion is a bug hidden in the scoring.
5. **No null-field lists.** `gradeNoInventedParams` derives restraint from omissions at both
   the top level and inside `trips[]`. This is field-aware rather than a recursive key diff:
   location and date expectations are matcher objects, not literal copies of model output.

**The width of the window is the tolerance**, stated rather than computed, and `departure_date`
and `return_date` carry their own. Keep each one to what the query actually permits: a single
day for an explicit date, the calendar month for "next month". A window wider than the query
passes answers that are wrong and quietly turns `gradeDateRange` green.

### The pinned date

`eval.config.json` carries `today` (`MM/DD/YYYY`), overridable per run with `--today`. It is
**01/01/2026**, and it is required — `run.ts` throws without it rather than falling back to the
real date, which would tell the model it is some other day while the dataset keeps asserting
January-2026 answers. `results.json` records the pin, so every run is self-describing.

**The pin and the dataset are coupled**, and now that the dates are literal the coupling is
visible. "March 3" is `"03/03/26"` because the pin is January 2026; with an August 2026 pin the
same query means March 2027 and every such case is wrong until it is rewritten. Moving the pin
is a dataset edit that shows up in the diff, rather than a silent regrade.

**Do not auto-derive the pin from the dataset.** It is the obvious next step and it is a trap.
Computed as "earliest case date minus a month", adding one case that mentions January 2027
drags the pin back to December 2026 and changes what "next month" means to the model for every
other case, while their written-out windows sit still — a global regrade with nothing in the
diff to show it.

Pin it by hand, and **treat every case's dates as landing strictly after it**. That is an
assumption the dataset author holds up, not something the harness verifies: a load-time check
existed briefly and bought nothing that reading the cases does not.

`gradeDateSanity` is unaffected by that assumption and stays. It grades the *model's* dates
against the pin, which is a different question from whether the cases are well-formed — and it
is the only place a past departure is ever caught, since production clamps one to tomorrow
without comment.

Keep the pin plausible — near the real present. A pin years in the past invites the model to
reason about a world it knows has passed.

`es.jsonl` reuses the same `id` values so the two languages line up in the dashboard.

---

## Output

### `results.json`

```json
{
  "run_id": "2026-08-26T2210Z",
  "today": "08/26/2026",
  "model": "gpt-5.6-terra",
  "prompt": "v6",
  "repeats": 3,
  "cases": [
    {
      "id": "rt-duration-01", "lang": "en",
      "text": "round trip from Chicago to Tokyo next month for a week, 2 adults",
      "expect": { },
      "runs": [
        { "repeat": 1,
          "status": "ok",
          "passed": false,
          "grades": { "gradeAction": true, "gradeOrigin": true,
                      "gradeDestination": false, "gradeCabin": null },
          "actual": { },
          "usage": { "input": 1840, "output": 96, "reasoning": 0,
                     "cached": 0, "total": 1936 },
          "latency_ms": 812 }
      ]
    }
  ]
}
```

A run whose `status` is `ok` has a `passed` flag that is false when any applicable grade is
false. A run whose status is not `ok` has neither `grades` nor `passed`; that absence keeps a
bad API key out of the pass rates. Once M4 adds vendors, `runs[]` gains a `provider` field and
the top-level `model` becomes the per-provider block.

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
npm run eval -- --model gpt-5.4-mini
npm run eval -- --prompt v7
npm run eval -- --limit 2                     # first N cases, for cheap iteration
npm run eval -- --today 04/15/2027            # override the pin — case dates are written for it
```

Every flag takes a value, which is what keeps the argument parser to three lines.

**Calls are sequential.** 20 cases × 3 repeats × 3 providers is 180 calls, which is minutes,
not hours — and a worker pool is a real amount of code to read in exchange for time nobody is
waiting on. `providers/retry.ts` is written and deliberately not wired up for the same reason:
until rate limits actually show up in the error column, backoff is machinery with no job.
Both come back the moment a run is slow enough or flaky enough to justify them.

---

## Milestones

**M1 — the loop. Done.**
`providers/types.ts`, `providers/openai.ts`, `run.ts`, and three graders (`gradeAction`,
`gradeSearchType`, `gradeNoInventedParams`). Four English cases. Writes `results.json` with usage
recorded, prints a summary to the console. No dashboard — prove the call-and-grade loop before
building the view.

`run.ts` reads top to bottom in three passes — load, run, report — with sequential calls and no
helper indirection. Assuming `strict: true` is what buys most of that: an `ok` response is
known to match the schema, so the result is cast rather than validated, and envelope checking,
schema-parity diffing, and `gradeSchema` all stop being necessary.

Verified against a local mock of the Responses API, which exercises the whole path without
spending anything: mixed pass/fail/not-applicable grading, `--repeats 3`, and the three non-`ok`
statuses — `error`, `refusal`, and `incomplete` — where refusal and incomplete still count their
tokens. Restraint is derived from omitted expectations, so there is no null-field list to
mistype. Total API failure prints `—` per grader, never 0%, which is the property the `status`
field exists for.

**M2 — full graders and dataset. Done.**
The other nine graders. 10 English + 10 Spanish cases, same ids in both.

`dates.ts` is the whole date layer: `toDay` and `toRange`, 23 lines, both pure parsing.
`gradeDateRange` and `gradeDateSanity` are then range comparisons on day numbers. `toDay`
returns `NaN` rather than throwing on a malformed date, which is what lets both grade the
format instead of crashing on it — the schema's date `pattern` is commented out, so the format
is not actually guaranteed — and `NaN` failing every comparison is what makes a malformed model
date fall out as a miss with no special case for it.

`resolveDate` lived here too, until the expected dates became literal windows. Case dates are
assumed to land after the pin, so `run.ts` does not check them and imports nothing from
`dates.ts`.

Verified by having the mock synthesize each case's *ideal* answer from its own `expect`, then
corrupting one dimension at a time. A clean run is 100% across all twelve graders; each of the
eleven corruptions flips exactly the grader it should. Two cross-flips, both correct: shifting
one leg of a multi-city trip past the next also fails `gradeDateSanity` on ordering, and adding
a `duration` where a `return_date` already exists also fails `gradeTripShape`.

Both the fixture and its corruptions read the pin from `eval.config.json` rather than hardcoding
it. A fixture pinned to a stale date reports a grader as broken when only the fixture is.

**M3 — fuzzy locations. Done.**
`src/semantic.ts`, the `fuzzy`/`name` fields on `LocationExpect`, the `grading` config block, and
the two location graders going async. Independent of the schema, the prompt, and the provider
interface, so the two new adapters land on a location column that already works.

Verified against the real embeddings endpoint with synthesized results: a concrete case still
grades on codes, a fuzzy case matches on name, and each of the four ways to get it wrong — a
give-up `"n/a"` on a resolvable place, the wrong region, a region collapsed to one airport, a
dropped qualifier — fails on its own. `"N/A"` triggers the check like `"n/a"`. An unasserted side
still returns `null`.

**No dataset cases yet.** The graders are wired and the twenty existing cases are unaffected
(absent `fuzzy` is `false`), so nothing exercises the fuzzy path in a real run until cases land.

**M4 — the other two adapters.**
`anthropic.ts`, `gemini.ts`, `toProviderSchema`, and `--check-schema`. Before the dashboard,
not after: a dashboard designed against one provider's results gets rebuilt the moment a
second one lands, and the schema-parity output is a thing the dashboard has to display.

**M5 — dashboard.**
`dashboard.ts`. Reads `results.json`, writes `index.html`, including token and cost columns
and the parity banner.

**M6 — configurability.**
Repeats, model override, prompt variants. Two prompt files, one run, paired comparison on
identical cases.

---

## Open

- **Prompt fairness across vendors.** The same prompt text is the fair comparison and also the
  handicap: `v6` was tuned against OpenAI. A per-vendor prompt variant would measure each
  vendor at its best but stop being a controlled comparison. Run both and report both.
- **Prompt caching.** Off for now; the fields are logged so it is a config change later.
- **Location-name language.** `v6` does not say what language `name` comes back in, so `es`
  cases may score against an English name. Write each case's `name` in its own language, then
  check the raw output of the first run — that is what settles it, and 0.80 with it.
- **Prompt drift** from the deployed Worker. Header comment now, CI check later.
- **Scope of intent.** Cases must compile to checkable expectations. "Somewhere nice for a
  honeymoon" does not. Worth stating in the README.

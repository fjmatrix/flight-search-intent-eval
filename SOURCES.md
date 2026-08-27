# Copied from flightcat_worker

Source repo: `/Users/frankjia/Documents/src/flightcat_worker`
Commit: `356fa6414e9a9e24a2cd7d135ced4e82c3964403` (2026-08-12)

| File here | Source there |
|---|---|
| `prompts/v6.txt` | `apps/backend/src/openai/searchPrompt_v6_finetune.ts` — the `system` message string, with `${todaysDate}` rewritten as `{{todaysDate}}` |
| `schema/search-input.json` | `constructPayload`'s `response_format.json_schema.schema`, with `searchInputJsonSchema` from `packages/search-contract/src/ai-search-input.ts` inlined at `result[1].properties.params` |
| `eval.config.json` → `providers.openai` | `constructPayload`'s `model`, `temperature`, `seed`, `reasoning_effort`, `max_completion_tokens` |

Provenance lives in this file rather than in per-file headers: `prompts/v6.txt` is
byte-sensitive (a header would become part of the prompt) and `schema/search-input.json`
is sent to the API verbatim under `strict: true`, where an unrecognized `$comment` key
is a risk not worth taking.

These will drift from the deployed Worker. A CI check comparing them can come later.

## Known drift at time of copy

- `parseOpenAiStructuredOutput` in `handleOpenai.ts` accepts `reason: 'invalid_date'`,
  but the schema's `reason` enum is `['off_topic', 'invalid_other']`. The schema is
  authoritative here, so `invalid_date` is unreachable. Copied as-is.
- The prompt contains a double space after "multi." and a typographic apostrophe (U+2019)
  in "trip's". Both preserved exactly — this is the string production sends.

## Unpriced models

`eval.config.json` carries a `pricing` block in $/MTok. `gpt-5.6-terra` is `null` until
filled in; cost columns land in M4 and will render as "—" for any model without a price.

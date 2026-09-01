import Anthropic from '@anthropic-ai/sdk'
import {
  NO_USAGE,
  type JsonSchema,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type TokenUsage,
} from './types.ts'

/** Lazy so the SDK's missing-key throw happens at call time, not at import. */
let client: Anthropic | undefined
const getClient = () => (client ??= new Anthropic())

/**
 * `input` counts every input token the call billed for. Anthropic reports
 * uncached, cache-read and cache-write separately, so they are summed back
 * together for `input` and also kept apart, because each bills at its own rate.
 * Thinking tokens bill as output and are not reported apart from it.
 */
function readUsage(usage: Anthropic.Usage | undefined): TokenUsage {
  if (!usage) return NO_USAGE
  const cached = usage.cache_read_input_tokens ?? 0
  const written = usage.cache_creation_input_tokens ?? 0
  const input = usage.input_tokens + cached + written
  return {
    input,
    output: usage.output_tokens,
    reasoning: null,
    cached,
    written,
    total: input + usage.output_tokens,
  }
}

/**
 * Rewrites the shared schema into the subset Anthropic's json_schema format takes:
 * it rejects numeric bounds and array size caps, so those are dropped. Nothing
 * re-checks them afterwards, so an Anthropic run can return an out-of-range number
 * where the same schema on OpenAI could not. String bounds and minItems at 0 or 1
 * are accepted and enforced, so they pass through.
 */
function adaptSchema(schema: JsonSchema): JsonSchema {
  // Everything named here is dropped; `accepted` is what Anthropic takes verbatim.
  const {
    minimum,
    maximum,
    exclusiveMinimum,
    exclusiveMaximum,
    multipleOf,
    maxItems,
    uniqueItems,
    minItems,
    properties,
    items,
    anyOf,
    allOf,
    oneOf,
    ...accepted
  } = schema

  const out: JsonSchema = { ...accepted }

  // minItems is taken at 0 and 1, rejected above.
  if (typeof minItems === 'number' && minItems <= 1) out.minItems = minItems

  // The places a subschema can appear, each rebuilt through this function.
  if (properties) {
    out.properties = Object.fromEntries(
      Object.entries(properties as Record<string, JsonSchema>).map(([name, sub]) => [
        name,
        adaptSchema(sub),
      ]),
    )
  }
  if (items) out.items = adaptSchema(items as JsonSchema)
  if (anyOf) out.anyOf = (anyOf as JsonSchema[]).map(adaptSchema)
  if (allOf) out.allOf = (allOf as JsonSchema[]).map(adaptSchema)
  if (oneOf) out.oneOf = (oneOf as JsonSchema[]).map(adaptSchema)

  return out
}

export const anthropic: Provider = {
  name: 'anthropic',

  async call(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now()
    try {
      const response = await getClient().messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        // One breakpoint here covers the schema as well as the system prompt:
        // both render ahead of the messages, and only the case text after it
        // changes between calls. A prefix under the model's minimum cacheable
        // length is silently not cached — that minimum is 4096 tokens on
        // Haiku 4.5, which this prompt does not reach.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
        output_config: {
          format: { type: 'json_schema', schema: adaptSchema(req.schema) },
          ...(req.effort ? { effort: req.effort } : {}),
        },
        ...req.params,
      } as Anthropic.MessageCreateParamsNonStreaming)

      const base = { usage: readUsage(response.usage), latency_ms: Date.now() - started }

      if (response.stop_reason === 'refusal') {
        return {
          ...base,
          output: null,
          status: 'refusal',
          error: response.stop_details?.explanation ?? 'refusal',
        }
      }
      if (response.stop_reason === 'max_tokens') {
        return { ...base, output: null, status: 'incomplete', error: 'max_tokens' }
      }

      // The json_schema format guarantees the text blocks parse to the schema.
      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      return { ...base, output: JSON.parse(text), status: 'ok' }
    } catch (error) {
      return {
        output: null,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        usage: NO_USAGE,
        latency_ms: Date.now() - started,
      }
    }
  },
}

import Anthropic from '@anthropic-ai/sdk'
import {
  NO_USAGE,
  type JsonSchema,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type TokenUsage,
} from './types.ts'
import { errorMessage, RetryError, withRetry } from './retry.ts'

/** One call plus three retries. */
const MAX_ATTEMPTS = 4

/** Lazy client with retries delegated to withRetry. */
let client: Anthropic | undefined
const getClient = () => (client ??= new Anthropic({ maxRetries: 0 }))

/** Normalizes usage: cache reads/writes are in input; reasoning stays in output. */
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

/** Drops unsupported numeric and array constraints; keeps minItems up to 1. */
function adaptSchema(schema: JsonSchema): JsonSchema {
  // Strip unsupported constraints.
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

  // Anthropic rejects minItems above 1.
  if (typeof minItems === 'number' && minItems <= 1) out.minItems = minItems

  // Recursively adapt nested schemas.
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
      const { value: response, attempts } = await withRetry(MAX_ATTEMPTS, () =>
        getClient().messages.create({
          model: req.model,
          max_tokens: req.maxTokens,
          // Cache the stable schema and system prefix; short prefixes remain uncached.
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: req.user }],
          output_config: {
            format: { type: 'json_schema', schema: adaptSchema(req.schema) },
            ...(req.effort ? { effort: req.effort } : {}),
          },
          ...req.params,
        } as Anthropic.MessageCreateParamsNonStreaming),
      )

      const base = { usage: readUsage(response.usage), attempts, latency_ms: Date.now() - started }

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

      // json_schema guarantees valid structured output.
      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      return { ...base, output: JSON.parse(text), status: 'ok' }
    } catch (error) {
      return {
        output: null,
        status: 'error',
        error: errorMessage(error),
        // Parsing fails after one call.
        attempts: error instanceof RetryError ? error.attempts : 1,
        usage: NO_USAGE,
        latency_ms: Date.now() - started,
      }
    }
  },
}

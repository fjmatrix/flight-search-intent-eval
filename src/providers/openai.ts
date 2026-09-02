import OpenAI from 'openai'
import {
  NO_USAGE,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type TokenUsage,
} from './types.ts'
import { errorMessage, RetryError, withRetry } from './retry.ts'

/** One call plus three retries. Past that a 429 is a rate limit to run under, not to wait out. */
const MAX_ATTEMPTS = 4

/**
 * Lazy so the SDK's missing-key throw happens at call time, not at import.
 * maxRetries: 0 hands retrying to withRetry, so the count a run reports is the
 * whole story of what the call cost.
 */
let client: OpenAI | undefined
const getClient = () => (client ??= new OpenAI({ maxRetries: 0 }))

function readUsage(usage: OpenAI.Responses.ResponseUsage | undefined): TokenUsage {
  if (!usage) return NO_USAGE
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    reasoning: usage.output_tokens_details.reasoning_tokens,
    cached: usage.input_tokens_details.cached_tokens,
    written: usage.input_tokens_details.cache_write_tokens ?? 0,
    total: usage.total_tokens,
  }
}

export const openai: Provider = {
  name: 'openai',

  async call(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now()
    try {
      const { value: response, attempts } = await withRetry(MAX_ATTEMPTS, () =>
        getClient().responses.create({
          model: req.model,
          instructions: req.system,
          input: req.user,
          max_output_tokens: req.maxTokens,
          text: {
            format: {
              type: 'json_schema',
              name: 'flight_search_result',
              strict: true,
              schema: req.schema,
            },
          },
          ...(req.effort ? { reasoning: { effort: req.effort as OpenAI.ReasoningEffort } } : {}),
          ...req.params,
        }),
      )

      const base = { usage: readUsage(response.usage), attempts, latency_ms: Date.now() - started }

      if (response.status === 'incomplete') {
        const reason = response.incomplete_details?.reason ?? 'unknown'
        return { ...base, output: null, status: 'incomplete', error: reason }
      }

      const refusal = response.output
        .flatMap((item) => (item.type === 'message' ? item.content : []))
        .find((part) => part.type === 'refusal')
      if (refusal) {
        return { ...base, output: null, status: 'refusal', error: refusal.refusal }
      }

      // strict: true guarantees the text parses and matches the schema.
      return { ...base, output: JSON.parse(response.output_text), status: 'ok' }
    } catch (error) {
      return {
        output: null,
        status: 'error',
        error: errorMessage(error),
        // A throw from outside withRetry — parsing the response — took one call.
        attempts: error instanceof RetryError ? error.attempts : 1,
        usage: NO_USAGE,
        latency_ms: Date.now() - started,
      }
    }
  },
}

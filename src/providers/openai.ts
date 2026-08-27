import OpenAI from 'openai'
import {
  emptyUsage,
  num,
  type JsonSchema,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type TokenUsage,
} from './types.ts'
import { errorMessage, RetryError, withRetry } from './retry.ts'

/**
 * Chat Completions, not the Responses API: `constructPayload` in flightcat_worker
 * posts to /v1/chat/completions with `response_format`, and an eval that measures a
 * different API surface than production ships is measuring the wrong thing.
 *
 * maxRetries: 0 — retries are handled by withRetry so `attempts` is observable.
 *
 * Constructed lazily: the SDK throws on a missing key at construction, and
 * --check-schema and --dry-run must run without credentials.
 */
let client: OpenAI | undefined

function getClient(): OpenAI {
  client ??= new OpenAI({ maxRetries: 0 })
  return client
}

const SCHEMA_NAME = 'flight_search_result'

function readUsage(usage: OpenAI.CompletionUsage | undefined): TokenUsage {
  if (!usage) return emptyUsage()
  const promptDetails = usage.prompt_tokens_details
  const completionDetails = usage.completion_tokens_details
  return {
    input: num(usage.prompt_tokens),
    output: num(usage.completion_tokens),
    reasoning:
      typeof completionDetails?.reasoning_tokens === 'number'
        ? completionDetails.reasoning_tokens
        : null,
    cache_read: num(promptDetails?.cached_tokens),
    // Chat Completions has no cache-write counter; OpenAI caching is automatic.
    cache_write: 0,
    total: num(usage.total_tokens),
    raw: usage,
  }
}

export const openai: Provider = {
  name: 'openai',

  /**
   * Identity. `strict: true` narrows what JSON Schema OpenAI accepts (every property
   * required, additionalProperties: false) but does not rewrite the schema, and
   * schema/search-input.json already satisfies those constraints — it is the object
   * production sends. A violation surfaces as a 400 at call time, not a silent edit.
   */
  toProviderSchema(schema: JsonSchema) {
    return schema
  },

  async call(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now()
    let attempts = 0

    try {
      const result = await withRetry(req.maxAttempts, () =>
        getClient().chat.completions.create({
          model: req.model,
          max_completion_tokens: req.maxTokens,
          stream: false,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: SCHEMA_NAME,
              strict: true,
              schema: this.toProviderSchema(req.schema) as Record<string, unknown>,
            },
          },
          ...req.params,
        } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming),
      )
      attempts = result.attempts
      const completion = result.value

      const latency_ms = Date.now() - started
      const usage = readUsage(completion.usage)
      const choice = completion.choices[0]
      const meta = {
        model_id: completion.model,
        response_id: completion.id,
        ...(choice?.finish_reason ? { finish_reason: choice.finish_reason } : {}),
      }
      const base = { usage, latency_ms, attempts, meta }

      if (!choice) {
        return { ...base, output: null, status: 'parse_error', error: 'no choices' }
      }
      if (typeof choice.message.refusal === 'string') {
        return {
          ...base,
          output: null,
          status: 'refusal',
          error: choice.message.refusal,
        }
      }
      if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') {
        return {
          ...base,
          output: null,
          status: 'incomplete',
          error: `finish_reason: ${choice.finish_reason}`,
        }
      }

      const text = choice.message.content
      if (typeof text !== 'string') {
        return { ...base, output: null, status: 'parse_error', error: 'no content' }
      }
      try {
        return { ...base, output: JSON.parse(text), status: 'ok' }
      } catch (error) {
        return {
          ...base,
          output: null,
          status: 'parse_error',
          error: errorMessage(error),
          raw_text: text.slice(0, 2000),
        }
      }
    } catch (error) {
      return {
        output: null,
        status: 'api_error',
        error: errorMessage(error),
        usage: emptyUsage(),
        latency_ms: Date.now() - started,
        attempts: error instanceof RetryError ? error.attempts : Math.max(attempts, 1),
        meta: { model_id: req.model },
      }
    }
  },
}

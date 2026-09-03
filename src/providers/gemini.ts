import {
  GoogleGenAI,
  type GenerateContentResponseUsageMetadata,
  type ThinkingLevel,
} from '@google/genai'
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

/** Lazy so env loads before key validation. */
let client: GoogleGenAI | undefined
function getClient(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set')
  }
  // Disable SDK retries; withRetry owns them.
  return (client ??= new GoogleGenAI({ httpOptions: { retryOptions: { attempts: 1 } } }))
}

/** Normalizes usage: cached tokens are in input; reasoning tokens are in output. */
function readUsage(usage: GenerateContentResponseUsageMetadata | undefined): TokenUsage {
  if (!usage) return NO_USAGE
  const reasoning = usage.thoughtsTokenCount ?? 0
  const input = usage.promptTokenCount ?? 0
  const output = (usage.candidatesTokenCount ?? 0) + reasoning
  return {
    input,
    output,
    reasoning,
    cached: usage.cachedContentTokenCount ?? 0,
    written: 0,
    total: usage.totalTokenCount ?? input + output,
  }
}

/** Drops unsupported constraints; maxItems also exceeds Gemini's nested grammar limit. */
function adaptSchema(schema: JsonSchema): JsonSchema {
  // Strip unsupported constraints.
  const {
    maxItems,
    minLength,
    maxLength,
    pattern,
    multipleOf,
    uniqueItems,
    exclusiveMinimum,
    exclusiveMaximum,
    allOf,
    default: _default,
    $schema,
    enum: members,
    properties,
    items,
    anyOf,
    oneOf,
    ...accepted
  } = schema

  const out: JsonSchema = { ...accepted }

  // Express nullable enums as anyOf; preserve typed enums.
  if (Array.isArray(members)) {
    const values = members.filter((value) => value !== null)
    const memberType = values.every((value) => typeof value === 'string') ? 'string' : 'number'
    if (values.length === members.length && accepted.type !== undefined) {
      out.enum = members
    } else {
      delete out.type
      out.anyOf = [{ type: accepted.type ?? memberType, enum: values }, { type: 'null' }]
    }
  }

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
  if (oneOf) out.oneOf = (oneOf as JsonSchema[]).map(adaptSchema)

  return out
}

/** Model-chosen stops graded as refusals. */
const REFUSAL_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
])

export const gemini: Provider = {
  name: 'gemini',

  async call(req: ModelRequest): Promise<ModelResponse> {
    const started = Date.now()
    try {
      const { value: response, attempts } = await withRetry(MAX_ATTEMPTS, () =>
        getClient().models.generateContent({
          model: req.model,
          contents: req.user,
          config: {
            systemInstruction: req.system,
            maxOutputTokens: req.maxTokens,
            responseMimeType: 'application/json',
            responseJsonSchema: adaptSchema(req.schema),
            // Unsupported effort levels fail instead of being downgraded.
            ...(req.effort
              ? { thinkingConfig: { thinkingLevel: req.effort.toUpperCase() as ThinkingLevel } }
              : {}),
            ...req.params,
          },
        }),
      )

      const base = {
        usage: readUsage(response.usageMetadata),
        attempts,
        latency_ms: Date.now() - started,
      }

      // Blocked prompts have no candidates.
      const blocked = response.promptFeedback?.blockReason
      if (blocked) return { ...base, output: null, status: 'refusal', error: blocked }

      const finish = response.candidates?.[0]?.finishReason
      if (finish === 'MAX_TOKENS') {
        return { ...base, output: null, status: 'incomplete', error: 'MAX_TOKENS' }
      }
      if (finish && REFUSAL_REASONS.has(finish)) {
        return { ...base, output: null, status: 'refusal', error: finish }
      }
      if (finish && finish !== 'STOP') {
        return { ...base, output: null, status: 'error', error: finish }
      }

      // `text` omits thought parts.
      const text = response.text
      if (text === undefined) {
        return { ...base, output: null, status: 'error', error: 'no text in response' }
      }

      // Structured output parses as JSON; dropped constraints remain unchecked.
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

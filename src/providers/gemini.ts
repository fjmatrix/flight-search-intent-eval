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

/** One call plus three retries. Past that a 429 is a rate limit to run under, not to wait out. */
const MAX_ATTEMPTS = 4

/**
 * Lazy, so the key is read after run.ts has loaded .env and a missing one surfaces
 * as a failed call rather than an import-time throw.
 *
 * The other two SDKs throw on a missing key. This one only warns, then falls back
 * to application default credentials and fails the request with `invalid_grant` —
 * a message that says nothing about the key. The check is here so it reads as what
 * it is.
 */
let client: GoogleGenAI | undefined
function getClient(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set')
  }
  // retryOptions.attempts of 1 means no retry of the SDK's own: withRetry owns
  // them, so the count a run reports is the whole story of what the call cost.
  return (client ??= new GoogleGenAI({ httpOptions: { retryOptions: { attempts: 1 } } }))
}

/**
 * `input` is promptTokenCount, which already counts the cached prefix, so `cached`
 * sits inside `input` the way the dashboard's cost math expects.
 *
 * Thinking tokens are the vendor difference worth naming: Gemini reports them
 * outside candidatesTokenCount, where OpenAI folds reasoning into output_tokens.
 * They bill at the output rate and costOf prices `output` alone, so they are added
 * into `output` here and reported on their own in `reasoning` as well. A missing
 * thoughtsTokenCount means the model produced no thoughts, not that the vendor
 * withheld the count, so it reads as 0 rather than null.
 *
 * `written` stays 0: implicit caching reports no write count, and explicit cache
 * creation is a separate API this adapter does not call.
 */
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

/**
 * Rewrites the shared schema into what `responseJsonSchema` accepts. That surface
 * takes JSON Schema rather than the OpenAPI 3.0 subset behind `responseSchema`, so
 * anyOf, additionalProperties, required, enum, numeric bounds and minItems all
 * survive and the translation is close to the identity.
 *
 * maxItems is dropped. Gemini unrolls a bounded array into that many copies of its
 * item schema when it compiles the decoding grammar, and nested bounds multiply:
 * this schema's 8 trips of up to 10 departures and 20 arrivals is over an internal
 * size limit, and every call comes back 400 INVALID_ARGUMENT naming no field. The
 * bound is not re-checked afterwards, so a Gemini run can return more trips or more
 * locations per trip than the same schema allows on OpenAI.
 *
 * String length bounds are what it also does not take: minLength and maxLength are
 * dropped, and nothing re-checks them afterwards either, so a Gemini run can return
 * a location name longer than the 100 characters the schema enforces on OpenAI.
 * Also dropped, none of which the current schema uses: pattern, multipleOf,
 * uniqueItems, exclusive bounds, allOf, default and $schema.
 *
 * $defs, $ref and prefixItems are accepted by the vendor but not translated here,
 * because the shared schema holds none of them.
 */
function adaptSchema(schema: JsonSchema): JsonSchema {
  // Everything named here is dropped; `accepted` is what Gemini takes verbatim.
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

  // An enum is read alongside a string or number type, and null is not a member a
  // typed enum can hold. The schema's one bare enum — cabins, whose members
  // include null — becomes the anyOf-with-null shape every other nullable field in
  // the schema already uses. A typed enum without null passes through untouched.
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
  if (oneOf) out.oneOf = (oneOf as JsonSchema[]).map(adaptSchema)

  return out
}

/**
 * Generation stopped for a reason the model chose, rather than one the eval can
 * fix. These are graded the same way an OpenAI refusal is: not a failed case.
 */
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
            // Gemini names the levels MINIMAL, LOW, MEDIUM and HIGH. The config's
            // low, medium and high map straight across; anything else it carries —
            // xhigh, max — has no level here and comes back a 400, which is the
            // visible failure rather than a silent downgrade to another depth.
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

      // A prompt blocked before generation comes back with no candidates at all.
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

      // `text` concatenates the candidate's text parts and leaves out its thoughts.
      const text = response.text
      if (text === undefined) {
        return { ...base, output: null, status: 'error', error: 'no text in response' }
      }

      // responseJsonSchema constrains decoding, so the text parses to the schema —
      // minus the string length bounds adaptSchema had to drop.
      return { ...base, output: JSON.parse(text), status: 'ok' }
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

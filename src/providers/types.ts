/**
 * The vendor boundary. `run.ts` sees only `Provider` and never branches on vendor;
 * request format, schema configuration, and response parsing live in the adapters.
 */

export type JsonSchema = Record<string, unknown>

export type ProviderName = 'openai' | 'anthropic' | 'gemini'

export interface ModelRequest {
  /** Prompt text, `{{todaysDate}}` already substituted. */
  system: string
  /** The case's query text. */
  user: string
  /** The vendor-neutral schema/search-input.json. Adapters must not mutate it. */
  schema: JsonSchema
  model: string
  maxTokens: number
  /** Vendor-specific knobs, passed through from eval.config.json. */
  params: Record<string, unknown>
  /** Attempts allowed per call, including the first. */
  maxAttempts: number
}

export interface TokenUsage {
  input: number
  output: number
  /** null when the vendor does not report reasoning tokens separately. */
  reasoning: number | null
  cache_read: number
  cache_write: number
  /** Vendor-reported where available; never summed by hand across overlapping fields. */
  total: number
  /** The vendor's usage object, verbatim. */
  raw: unknown
}

/**
 * `schema_error` is set by run.ts, not by adapters — the `{ result: ... }` envelope
 * is this eval's contract, not the vendor's, so validating it is vendor-neutral work.
 * Adapters return the parsed JSON exactly as the model produced it.
 */
export type RunStatus =
  | 'ok'
  | 'refusal'
  | 'incomplete'
  | 'parse_error'
  | 'schema_error'
  | 'api_error'

export interface ModelResponse {
  output: unknown | null
  status: RunStatus
  error?: string
  /** What came back when parsing failed. Truncated by the adapter if huge. */
  raw_text?: string
  usage: TokenUsage
  latency_ms: number
  attempts: number
  meta: { model_id: string; response_id?: string; finish_reason?: string }
}

export interface Provider {
  name: ProviderName
  call(req: ModelRequest): Promise<ModelResponse>
  /** Exported for --check-schema; identity where the vendor takes JSON Schema as-is. */
  toProviderSchema(schema: JsonSchema): unknown
}

export function emptyUsage(): TokenUsage {
  return {
    input: 0,
    output: 0,
    reasoning: null,
    cache_read: 0,
    cache_write: 0,
    total: 0,
    raw: null,
  }
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

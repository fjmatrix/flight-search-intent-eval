/**
 * The vendor boundary. Request format, schema configuration, and response parsing
 * live in the adapters; nothing outside them knows which vendor is being called.
 */

export type JsonSchema = Record<string, unknown>

export interface ModelRequest {
  /** Prompt text, `{{todaysDate}}` already substituted. */
  system: string
  /** The case's query text. */
  user: string
  schema: JsonSchema
  model: string
  maxTokens: number
  /** Vendor-specific knobs, passed through from eval.config.json. */
  params: Record<string, unknown>
}

export interface TokenUsage {
  input: number
  output: number
  /** null when the vendor does not report reasoning tokens separately. */
  reasoning: number | null
  cached: number
  total: number
}

export type RunStatus = 'ok' | 'refusal' | 'incomplete' | 'error'

export interface ModelResponse {
  /** The parsed JSON the model produced, or null when status is not 'ok'. */
  output: unknown
  status: RunStatus
  error?: string
  usage: TokenUsage
  latency_ms: number
}

export interface Provider {
  name: string
  call(req: ModelRequest): Promise<ModelResponse>
}

export const NO_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  reasoning: null,
  cached: 0,
  total: 0,
}

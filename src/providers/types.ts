/** Provider-neutral request and response types. */

export type JsonSchema = Record<string, unknown>

export interface ModelRequest {
  /** System prompt with today's date substituted. */
  system: string
  /** Case query. */
  user: string
  schema: JsonSchema
  model: string
  maxTokens: number
  /** Reasoning depth. */
  effort: string | null
  /** Vendor options from eval.config.json. */
  params: Record<string, unknown>
}

export interface TokenUsage {
  input: number
  output: number
  /** null when reasoning is not reported separately. */
  reasoning: number | null
  /** Cached portion of input. */
  cached: number
  /** Cache-written portion of input. */
  written: number
  total: number
}

export type RunStatus = 'ok' | 'refusal' | 'incomplete' | 'error'

export interface ModelResponse {
  /** Parsed JSON, or null on failure. */
  output: unknown
  status: RunStatus
  error?: string
  /** Total calls, including retries. */
  attempts: number
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
  written: 0,
  total: 0,
}

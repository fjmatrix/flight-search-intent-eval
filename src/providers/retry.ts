/** Shared retry loop keeps provider attempt counts consistent. */

export interface Attempt<T> {
  value: T
  attempts: number
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])

export function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status
  if (typeof status === 'number') return RETRYABLE_STATUS.has(status)
  // Network failures may lack a status.
  return error instanceof Error && !('status' in error)
}

/** Preserves the attempt count after failure. */
export class RetryError extends Error {
  constructor(
    readonly attempts: number,
    override readonly cause: unknown,
  ) {
    super(errorMessage(cause))
    this.name = 'RetryError'
  }
}

export async function withRetry<T>(
  maxAttempts: number,
  fn: () => Promise<T>,
): Promise<Attempt<T>> {
  let lastError: unknown
  let attempt = 0
  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return { value: await fn(), attempts: attempt }
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts || !isRetryable(error)) break
      const backoff = 500 * 2 ** (attempt - 1) + Math.random() * 250
      await new Promise((resolve) => setTimeout(resolve, backoff))
    }
  }
  throw new RetryError(Math.min(attempt, maxAttempts), lastError)
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const status = (error as { status?: unknown }).status
  // Avoid duplicate status prefixes.
  if (typeof status !== 'number' || error.message.startsWith(String(status))) {
    return error.message
  }
  return `${status} ${error.message}`
}

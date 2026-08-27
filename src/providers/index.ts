import { openai } from './openai.ts'
import type { Provider, ProviderName } from './types.ts'

/**
 * Config selects a vendor by string, so dispatch needs a map. The graders stay
 * registry-free; that rule was about grading, not dispatch.
 * M3 adds anthropic and gemini.
 */
export const providers: Partial<Record<ProviderName, Provider>> = {
  openai,
}

export function getProvider(name: string): Provider {
  const provider = providers[name as ProviderName]
  if (!provider) {
    throw new Error(
      `unknown provider "${name}" (available: ${Object.keys(providers).join(', ')})`,
    )
  }
  return provider
}

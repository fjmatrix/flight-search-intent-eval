/**
 * The payload behind the README's score badge, in the shape shields.io's
 * endpoint badge reads: https://shields.io/badges/endpoint-badge
 */

import type { ViewData } from './view.ts'

export interface Badge {
  schemaVersion: 1
  label: string
  message: string
  color: string
}

/** The leaderboard's own bands, so the badge and the page never disagree. */
function color(rate: number): string {
  return rate >= 0.95 ? 'brightgreen' : rate >= 0.8 ? 'yellow' : rate >= 0.5 ? 'orange' : 'red'
}

/**
 * The leaderboard's top row. `models` arrives sorted by cases passed, so the
 * badge names whichever model the page already puts first; it ranks nothing
 * itself. A case counts as passed only when every repeat of it passed.
 */
export function badge(v: ViewData): Badge {
  const top = v.models[0]
  if (!top || v.total === 0) {
    return { schemaVersion: 1, label: 'top model', message: 'no runs', color: 'lightgrey' }
  }
  const rate = top.passed / v.total
  return {
    schemaVersion: 1,
    label: 'top model',
    message: `${top.key} · ${Math.round(rate * 100)}%`,
    color: color(rate),
  }
}

import type { Expect, ParsedResult } from './types.ts'

/** null = the case's `expect` has nothing to say about this dimension. */
export type Grade = boolean | null

export interface GradeContext {
  /** The same date injected into the prompt, MM/DD/YYYY. */
  today: string
}

export type Grader = (
  actual: ParsedResult,
  expect: Expect,
  ctx: GradeContext,
) => Grade

export function gradeAction(actual: ParsedResult, expect: Expect): Grade {
  if (expect.action === undefined) return null
  return actual.action === expect.action
}

export function gradeSearchType(actual: ParsedResult, expect: Expect): Grade {
  if (expect.search_type === undefined) return null
  // A case that expects a search type expects a search; handle_invalid is a miss,
  // not a not-applicable.
  if (actual.action !== 'get_tickets') return false
  return actual.params.search_type === expect.search_type
}

export function gradeRestraint(actual: ParsedResult, expect: Expect): Grade {
  const fields = expect.must_be_null
  if (fields === undefined || fields.length === 0) return null
  if (actual.action !== 'get_tickets') return false
  return fields.every((field) => actual.params[field] === null)
}

/**
 * Order is the column order in the report. M2 adds gradeOrigin, gradeDestination,
 * gradeDateRange, gradeDuration, gradePassengers, gradeCabin, gradeFilters, gradeSchema.
 */
export const GRADERS: Record<string, Grader> = {
  gradeAction,
  gradeSearchType,
  gradeRestraint,
}

export function gradeAll(
  actual: ParsedResult,
  expect: Expect,
  ctx: GradeContext,
): Record<string, Grade> {
  const grades: Record<string, Grade> = {}
  for (const [name, grader] of Object.entries(GRADERS)) {
    grades[name] = grader(actual, expect, ctx)
  }
  return grades
}

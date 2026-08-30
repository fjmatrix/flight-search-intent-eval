import { toDay, toRange } from './dates.ts'
import { isSimilar, type GradingConfig } from './semantic.ts'
import type {
  AiSearchLocation,
  AiSearchTrip,
  Expect,
  LocationExpect,
  ParsedResult,
  TripExpect,
} from './types.ts'

/** null = the case's `expect` has nothing to say about this dimension. */
export type Grade = boolean | null

export interface GradeContext {
  /** The same date injected into the prompt, MM/DD/YYYY. */
  today: string
  grading: GradingConfig
}

/** Async only because the two location graders embed names for fuzzy cases. */
export type Grader = (
  actual: ParsedResult,
  expect: Expect,
  ctx: GradeContext,
) => Grade | Promise<Grade>

// --- helpers -----------------------------------------------------------------

/** Structural equality, indifferent to key order. Values here are small and flat. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => same(value, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a).sort()
    if (!same(keys, Object.keys(b).sort())) return false
    return keys.every((key) =>
      same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  }
  return a === b
}

/** `findIndex` for a predicate that has to be awaited; -1 when none matches. */
async function findIndexAsync<T>(
  items: T[],
  predicate: (item: T) => Promise<boolean>,
): Promise<number> {
  for (const [i, item] of items.entries()) {
    if (await predicate(item)) return i
  }
  return -1
}

/**
 * Expected trips paired with the actual ones, or null when they cannot be
 * compared at all. That null means "counts as a failure", not "not applicable" —
 * callers turn it into false.
 */
function pairTrips(actual: ParsedResult, expect: Expect): [AiSearchTrip, TripExpect][] | null {
  if (actual.action !== 'get_tickets') return null
  const expected = expect.trips ?? []
  const trips = actual.params.trips
  if (expected.length !== trips.length) return null
  return expected.map((trip, i) => [trips[i]!, trip])
}

/**
 * True when every location the model returned satisfies the case. A non-fuzzy
 * case is satisfied by an accepted IATA code; a fuzzy one when the returned
 * locations pair off one-to-one with the regions the case names, each pair
 * close enough to count. Order does not matter: a query naming several places
 * puts no order on the response.
 */
async function locationsMatch(
  actual: AiSearchLocation[],
  expected: LocationExpect,
  ctx: GradeContext,
): Promise<boolean> {
  if (actual.length === 0) return false
  // Exact location. expecting IATA code
  if (!expected.fuzzy) {
    return actual.every((location) => expected.any_code!.includes(location.code))
  }

  // One name per location, so a query naming five countries is only satisfied
  // by five locations — not by one that stands for all of them.
  const unmatched = [...expected.names!]
  if (actual.length !== unmatched.length) return false

  for (const location of actual) {
    // The test case says this place has no IATA code, so any code here is wrong.
    // Failing now also skips an embedding call that could not change the answer.
    if (location.code.trim().toLowerCase() !== 'n/a') return false

    // First name that clears the threshold claims this location. The names in a
    // case are far enough apart that no later location wants the same one.
    const index = await findIndexAsync(unmatched, (name) =>
      isSimilar(name, location.name, ctx.grading),
    )
    if (index === -1) return false
    unmatched.splice(index, 1)
  }
  return true
}

/**
 * The model's date has to sit inside the window the case names. A case that
 * names a single day accepts only that day; a vague query gets a window wide
 * enough to hold every reading of it. A malformed date on either side is NaN,
 * and every comparison against NaN is false, so it fails.
 */
function dateMatches(actual: string | null, expected: string | undefined): boolean {
  if (expected === undefined) return true
  if (!actual) return false
  const [first, last] = toRange(actual)
  const [from, to] = toRange(expected)
  return first >= from && last <= to
}

// --- graders -----------------------------------------------------------------

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

export async function gradeOrigin(
  actual: ParsedResult,
  expect: Expect,
  ctx: GradeContext,
): Promise<Grade> {
  if (!expect.trips?.some((trip) => trip.departure)) return null
  const paired = pairTrips(actual, expect)
  if (!paired) return false

  for (const [trip, e] of paired) {
    if (e.departure && !(await locationsMatch(trip.departure, e.departure, ctx))) return false
  }
  return true
}

export async function gradeDestination(
  actual: ParsedResult,
  expect: Expect,
  ctx: GradeContext,
): Promise<Grade> {
  if (!expect.trips?.some((trip) => trip.arrival)) return null
  const paired = pairTrips(actual, expect)
  if (!paired) return false

  for (const [trip, e] of paired) {
    if (e.arrival && !(await locationsMatch(trip.arrival, e.arrival, ctx))) return false
  }
  return true
}

export function gradeDateRange(actual: ParsedResult, expect: Expect): Grade {
  if (!expect.trips?.some((trip) => trip.departure_date || trip.return_date)) return null
  const paired = pairTrips(actual, expect)
  if (!paired) return false
  return paired.every(
    ([trip, e]) =>
      dateMatches(trip.departure_date, e.departure_date) &&
      dateMatches(trip.return_date, e.return_date),
  )
}

export function gradeDuration(actual: ParsedResult, expect: Expect): Grade {
  if (!expect.trips?.some((trip) => trip.duration !== undefined)) return null
  const paired = pairTrips(actual, expect)
  if (!paired) return false
  return paired.every(([trip, e]) => e.duration === undefined || trip.duration === e.duration)
}

export function gradePassengers(actual: ParsedResult, expect: Expect): Grade {
  if (expect.passengers === undefined) return null
  if (actual.action !== 'get_tickets') return false
  return same(actual.params.passengers, expect.passengers)
}

export function gradeCabin(actual: ParsedResult, expect: Expect): Grade {
  if (expect.cabins === undefined) return null
  if (actual.action !== 'get_tickets') return false
  return actual.params.cabins === expect.cabins
}

const FILTERS = [
  'max_stops',
  'max_price',
  'flight_duration',
  'connecting_airports',
  'bags',
] as const

const OPTIONAL_PARAMS = ['passengers', 'cabins', ...FILTERS] as const
const OPTIONAL_TRIP_FIELDS = ['departure_date', 'return_date', 'duration'] as const

export function gradeFilters(actual: ParsedResult, expect: Expect): Grade {
  const asserted = FILTERS.filter((field) => expect[field] !== undefined)
  if (asserted.length === 0) return null
  if (actual.action !== 'get_tickets') return false
  return asserted.every((field) => same(actual.params[field], expect[field]))
}

/**
 * Search expectations are closed-world for nullable values: when the case does
 * not name one, the model must return null. Required locations and matcher
 * objects are graded separately because `expect` does not mirror their literal
 * response shape.
 */
export function gradeNoInventedParams(actual: ParsedResult, expect: Expect): Grade {
  if (actual.action !== 'get_tickets') return null

  const expectedTrips = expect.trips
  if (expect.search_type === undefined || expectedTrips === undefined) return false
  if (actual.params.trips.length !== expectedTrips.length) return false

  if (
    !OPTIONAL_PARAMS.every(
      (field) => expect[field] !== undefined || actual.params[field] === null,
    )
  ) {
    return false
  }

  return actual.params.trips.every((trip, index) => {
    const expected = expectedTrips[index]!
    if (expected.departure === undefined || expected.arrival === undefined) return false
    return OPTIONAL_TRIP_FIELDS.every(
      (field) => expected[field] !== undefined || trip[field] === null,
    )
  })
}

/**
 * Invariants of any valid search, so this takes no `expect` and covers every case.
 * A past departure is invisible in production — prepareDate() clamps it to
 * tomorrow — which is exactly why it needs a column here.
 */
export function gradeDateSanity(actual: ParsedResult, _expect: Expect, ctx: GradeContext): Grade {
  if (actual.action !== 'get_tickets') return null
  const pin = toDay(ctx.today)
  let previousDeparture = -Infinity

  for (const trip of actual.params.trips) {
    if (trip.departure_date === null) continue // null is legal; production defaults it
    const [departure, departureEnd] = toRange(trip.departure_date)
    if (Number.isNaN(departure) || Number.isNaN(departureEnd)) return false
    if (departure < pin || departureEnd < departure) return false

    if (trip.return_date !== null) {
      const [returning] = toRange(trip.return_date)
      if (Number.isNaN(returning) || returning < departure) return false
    }
    if (actual.params.search_type === 'multi' && departure <= previousDeparture) return false
    previousDeparture = departure
  }
  return true
}

/**
 * The other unenforced rule: `return_date` and `duration` are mutually exclusive
 * in prose only, and downstream `return_date` silently wins. Both null is fine —
 * production falls back to a default duration.
 */
export function gradeTripShape(actual: ParsedResult): Grade {
  if (actual.action !== 'get_tickets') return null
  const { search_type, trips } = actual.params
  if (search_type === 'multi' ? trips.length < 2 : trips.length !== 1) return false
  return trips.every(
    (trip) =>
      !(trip.return_date && trip.duration) &&
      (search_type !== 'oneway' || (!trip.return_date && !trip.duration)),
  )
}

/** Order here is the column order in the report. */
export const GRADERS: Record<string, Grader> = {
  gradeAction,
  gradeSearchType,
  gradeOrigin,
  gradeDestination,
  gradeDateRange,
  gradeDuration,
  gradePassengers,
  gradeCabin,
  gradeFilters,
  gradeNoInventedParams,
  gradeDateSanity,
  gradeTripShape,
}

export async function gradeAll(
  actual: ParsedResult,
  expect: Expect,
  ctx: GradeContext,
): Promise<Record<string, Grade>> {
  const grades: Record<string, Grade> = {}
  for (const [name, grader] of Object.entries(GRADERS)) {
    grades[name] = await grader(actual, expect, ctx)
  }
  return grades
}

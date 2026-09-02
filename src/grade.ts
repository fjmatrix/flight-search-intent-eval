import { toDate, toDay, toRange } from './dates.ts'
import { normalize, scoreNames, type GradingConfig } from './semantic.ts'
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

/**
 * A trip states its stay one of two ways: `duration` nights, or a `return_date`.
 * The two say the same thing, so whichever one a trip leaves out is filled in
 * from the other before the trip is compared. Deriving needs a departure pinned
 * to a single day — a departure window plus a return day names no one stay
 * length — so a trip without one is compared as it stands.
 */
function withDerivedStay(trip: AiSearchTrip): AiSearchTrip {
  if (!trip.departure_date) return trip
  const [departure, departureEnd] = toRange(trip.departure_date)
  if (Number.isNaN(departure) || departure !== departureEnd) return trip

  if (trip.duration === null && trip.return_date !== null) {
    const [first, last] = toRange(trip.return_date)
    if (Number.isNaN(first) || Number.isNaN(last)) return trip
    const [shortest, longest] = [first - departure, last - departure]
    return { ...trip, duration: shortest === longest ? `${shortest}` : `${shortest}-${longest}` }
  }

  if (trip.return_date === null && trip.duration !== null) {
    const [shortest, longest] = toNights(trip.duration)
    if (!Number.isFinite(shortest) || !Number.isFinite(longest)) return trip
    const [first, last] = [toDate(departure + shortest), toDate(departure + longest)]
    return { ...trip, return_date: first === last ? first : `${first}-${last}` }
  }

  return trip
}

/**
 * Expected trips paired with the actual ones, or null when they cannot be
 * compared at all. That null means "counts as a failure", not "not applicable" —
 * callers turn it into false.
 *
 * Only the graders that reach a trip through here see a derived stay.
 * gradeTripShape and gradeDateSanity read `actual.params.trips` straight, so
 * "return_date and duration are mutually exclusive" is still checked against
 * what the model actually returned.
 */
function pairTrips(actual: ParsedResult, expect: Expect): [AiSearchTrip, TripExpect][] | null {
  if (actual.action !== 'get_tickets') return null
  const expected = expect.trips ?? []
  const trips = actual.params.trips
  if (expected.length !== trips.length) return null
  return expected.map((trip, i) => [withDerivedStay(trips[i]!), trip])
}

/**
 * True when every location the model returned is one the case accepts. A
 * non-fuzzy case accepts a set of IATA codes; a fuzzy one accepts a set of
 * names, and a returned name counts when it matches one of them outright or
 * scores at least the configured similarity against one.
 *
 * `names` is a pool of alternatives, not a checklist. Nothing here asks for one
 * location per name, so "east or south east asia" is answered by two locations
 * or by one that writes both, in any order.
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

  // The test case says these places have no IATA code, so any code here is wrong.
  // Failing now also skips an embedding call that could not change the answer.
  if (actual.some((location) => location.code.trim().toLowerCase() !== 'n/a')) return false

  const accepted = expected.names!
  // Names the case spells the same way settle here, so a set the model got
  // exactly right reaches the return below without embedding anything.
  const unmatched = actual
    .map((location) => location.name)
    .filter((name) => !accepted.some((option) => normalize(option) === normalize(name)))
  if (unmatched.length === 0) return true

  // One request scores every leftover pair; choosing among them is arithmetic.
  const scores = await scoreNames(accepted, unmatched, ctx.grading)

  // Every pair that was scored, printed whether or not it clears the threshold.
  accepted.forEach((option, row) => {
    unmatched.forEach((name, column) => {
      console.log(
        `expected:${option}; model output: ${name}; cosineSimilarity:${scores[row]![column]}`,
      )
    })
  })

  return unmatched.every((_, column) =>
    accepted.some((_, row) => scores[row]![column]! >= ctx.grading.similarity_threshold),
  )
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

/**
 * '7' or '3-5' to [shortest, longest] nights. A trailing '-' leaves the top
 * open: '14-' is [14, Infinity]. Only a case writes that form — it is never
 * sent to the model and never appears in a response — so "at least two weeks"
 * needs no new wire format. A malformed value on either side is NaN, and every
 * comparison against NaN is false, so it fails.
 */
function toNights(value: string): [number, number] {
  const [low, high] = value.trim().split('-')
  const shortest = low === '' ? NaN : Number(low)
  if (high === undefined) return [shortest, shortest]
  return [shortest, high === '' ? Infinity : Number(high)]
}

/**
 * Mirrors dateMatches: the case names the stays it accepts and the model's
 * answer has to sit inside that span. A query pinning one length accepts only
 * that length; '2-3 nights' accepts 2, 3, or the range itself.
 */
function durationMatches(actual: string | null, expected: string | undefined): boolean {
  if (expected === undefined) return true
  if (!actual) return false
  const [first, last] = toNights(actual)
  const [from, to] = toNights(expected)
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
  return paired.every(([trip, e]) => durationMatches(trip.duration, e.duration))
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

/** Filters whose value is a number or a small flat object, compared structurally. */
const PLAIN_FILTERS = ['max_stops', 'max_price', 'flight_duration', 'bags'] as const

/** Every filter the FILT column covers. `connecting_airports` holds locations. */
const FILTERS = [...PLAIN_FILTERS, 'connecting_airports'] as const

/**
 * Async because `connecting_airports` is a list of locations and gets the same
 * treatment a leg's departure does: accepted IATA codes, or fuzzy names scored
 * by embedding. A case naming a connection it does not get back fails here.
 */
export async function gradeFilters(
  actual: ParsedResult,
  expect: Expect,
  ctx: GradeContext,
): Promise<Grade> {
  if (FILTERS.every((field) => expect[field] === undefined)) return null
  if (actual.action !== 'get_tickets') return false

  const structural = PLAIN_FILTERS.every(
    (field) => expect[field] === undefined || same(actual.params[field], expect[field]),
  )
  if (!structural) return false

  const connections = expect.connecting_airports
  if (connections === undefined) return true
  return locationsMatch(actual.params.connecting_airports ?? [], connections, ctx)
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

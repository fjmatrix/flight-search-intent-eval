/** Domain types: the eval's dataset and the shape the model is asked to produce. */

export type Action = 'get_tickets' | 'handle_invalid'
export type SearchType = 'oneway' | 'roundtrip' | 'multi'

export interface AiSearchLocation {
  name: string
  code: string
}

export interface AiSearchTrip {
  departure: AiSearchLocation[]
  arrival: AiSearchLocation[]
  departure_date: string | null
  return_date: string | null
  duration: string | null
}

export interface AiSearchInput {
  search_type: SearchType
  passengers: { adults: number; children: number; infants: number } | null
  cabins: 'economy' | 'economyPremium' | 'business' | 'firstClass' | null
  max_stops: number | null
  max_price: number | null
  flight_duration: number | null
  connecting_airports: string[] | null
  bags: { checked: number; carry_on: number } | null
  trips: AiSearchTrip[]
}

/** What the model returns, once the `{ result: ... }` envelope is peeled off. */
export type ParsedResult =
  | { action: 'get_tickets'; params: AiSearchInput }
  | { action: 'handle_invalid'; reason: string }

/**
 * Top-level `params` fields a case may assert are null. Trip-level fields
 * (departure_date, return_date, duration) are deliberately absent: they live
 * inside `trips[]` and get their own graders in M2.
 */
export const NULLABLE_PARAM_FIELDS = [
  'passengers',
  'cabins',
  'max_stops',
  'max_price',
  'flight_duration',
  'connecting_airports',
  'bags',
] as const

export type NullableParamField = (typeof NULLABLE_PARAM_FIELDS)[number]

/**
 * A case's expectations. Every field is optional; absent means "don't care",
 * and the matching grader returns null rather than a pass.
 * M2 adds origin, destination, date_range, duration, passengers, cabins, filters.
 */
export interface Expect {
  action?: Action
  search_type?: SearchType
  must_be_null?: NullableParamField[]
}

export interface Case {
  id: string
  lang: string
  text: string
  expect: Expect
}

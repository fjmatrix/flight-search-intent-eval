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
  connecting_airports: AiSearchLocation[] | null
  bags: { checked: number; carry_on: number } | null
  trips: AiSearchTrip[]
}

/** What the model returns, once the `{ result: ... }` envelope is peeled off. */
export type ParsedResult =
  | { action: 'get_tickets'; params: AiSearchInput }
  | { action: 'handle_invalid'; reason: string }

/**
 * How a case asserts one side of a leg. Either a set of accepted IATA codes, or
 * `fuzzy` plus the regions the model's names get compared against.
 */
export interface LocationExpect {
  /** Accepted IATA codes. Any one of them is correct. */
  any_code?: string[]
  /** The intended location has no IATA code — "Texas", "west Europe". Absent means false. */
  fuzzy?: boolean
  /**
   * The names this side accepts, in any order. Read only when `fuzzy` is true.
   * They are alternatives — the region, an abbreviation, another language's
   * rendering, the query's own wording — and a returned location counts when it
   * matches any one of them. Listing several does not ask for several locations.
   */
  names?: string[]
}

/**
 * Mirrors `trips[]` positionally. Omitted nullable fields must be null in the
 * model response, except `departure_date` on a multi, which every leg carries;
 * departure and arrival are required for every expected trip.
 */
export interface TripExpect {
  departure: LocationExpect
  arrival: LocationExpect
  /** 'MM/DD/YY' or 'MM/DD/YY-MM/DD/YY'. The model's date must land inside it. */
  departure_date?: string
  return_date?: string
  /** Nights, '7' or '3-5'. The model's stay must land inside it; '14-' leaves the top open. */
  duration?: string
}

/**
 * A case's expectations. Every field is optional: an omitted one is not asserted,
 * and its grader returns null rather than pass or fail.
 */
export interface Expect {
  action?: Action
  search_type?: SearchType
  trips?: TripExpect[]
  passengers?: AiSearchInput['passengers']
  cabins?: AiSearchInput['cabins']
  max_stops?: AiSearchInput['max_stops']
  max_price?: AiSearchInput['max_price']
  flight_duration?: AiSearchInput['flight_duration']
  /** Graded like a trip's locations: accepted codes, or fuzzy names. */
  connecting_airports?: LocationExpect
  bags?: AiSearchInput['bags']
}

export interface Case {
  id: string
  lang: string
  text: string
  expect: Expect
  /** Report buckets this case counts toward. */
  tags?: string[]
}

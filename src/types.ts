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
 * How a case asserts one side of a leg. Either a set of accepted IATA codes, or
 * `fuzzy` plus the regions the model's names get compared against.
 */
export interface LocationExpect {
  /** Accepted IATA codes. Any one of them is correct. */
  any_code?: string[]
  /** The intended location has no IATA code — "Texas", "west Europe". Absent means false. */
  fuzzy?: boolean
  /**
   * One region per location the side is expected to hold, in any order. Read
   * only when `fuzzy` is true.
   */
  names?: string[]
}

/**
 * Mirrors `trips[]` positionally. Omitted nullable fields must be null in the
 * model response; departure and arrival are required for every expected trip.
 */
export interface TripExpect {
  departure: LocationExpect
  arrival: LocationExpect
  /** 'MM/DD/YY' or 'MM/DD/YY-MM/DD/YY'. The model's date must land inside it. */
  departure_date?: string
  return_date?: string
  duration?: string
}

/**
 * A case's expectations. For an expected search, omitted nullable params mean
 * "must be null". Dimension graders still return null when their field is not
 * asserted; gradeNoInventedParams enforces the omission.
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
  connecting_airports?: AiSearchInput['connecting_airports']
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

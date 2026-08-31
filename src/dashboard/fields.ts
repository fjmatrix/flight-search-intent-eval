/**
 * The slice of a case each grader reads, formatted on both sides: what `expect`
 * asserted, and what the model returned. Nothing here decides pass or fail —
 * `grade.ts` already did, and these strings only show what it compared.
 */

import type {
  AiSearchInput,
  AiSearchLocation,
  AiSearchTrip,
  Expect,
  LocationExpect,
  ParsedResult,
  TripExpect,
} from '../types.ts'

export interface Slice {
  exp: string
  got: string
}

/** Shared by both sides of Expect and AiSearchInput. */
const NULLABLE = [
  'passengers',
  'cabins',
  'max_stops',
  'max_price',
  'flight_duration',
  'connecting_airports',
  'bags',
] as const
const FILTER_KEYS = ['max_stops', 'max_price', 'flight_duration', 'connecting_airports', 'bags'] as const

const NONE = '—'
const join = (parts: (string | null | undefined)[], sep = ' · ') =>
  parts.filter(Boolean).join(sep) || NONE
const legs = (parts: string[]) => parts.join('  |  ') || NONE

/** Params only exist on a get_tickets result; everything else has none to show. */
const paramsOf = (r: ParsedResult | undefined): AiSearchInput | undefined =>
  r?.action === 'get_tickets' ? r.params : undefined
const noParams = (r: ParsedResult | undefined) => (r ? `action "${r.action}"` : 'no response')

const value = (v: unknown): string =>
  Array.isArray(v)
    ? v.join('+')
    : v && typeof v === 'object'
      ? Object.entries(v).map(([k, n]) => `${k} ${n}`).join(' ')
      : String(v)

const expectLoc = (e: LocationExpect | undefined): string =>
  !e ? NONE : e.fuzzy ? (e.names ?? []).map((n) => `≈ "${n}"`).join(' + ') : (e.any_code ?? []).join(' | ')

/** A code when the model resolved one, the raw name when it answered 'n/a'. */
const actualLoc = (ls: AiSearchLocation[] | undefined): string =>
  !ls?.length
    ? '[]'
    : ls.map((l) => (l.code && l.code.trim().toLowerCase() !== 'n/a' ? l.code : `"${l.name}"`)).join(' + ')

const expectTrips = (e: Expect, f: (t: TripExpect) => string) => legs((e.trips ?? []).map(f))
const actualTrips = (p: AiSearchInput, f: (t: AiSearchTrip) => string) => legs(p.trips.map(f))

const passengers = (p: AiSearchInput['passengers'] | undefined) =>
  !p
    ? 'null'
    : join(
        [
          `${p.adults} adult${p.adults === 1 ? '' : 's'}`,
          p.children ? `${p.children} child${p.children === 1 ? '' : 'ren'}` : null,
          p.infants ? `${p.infants} infant${p.infants === 1 ? '' : 's'}` : null,
        ],
        ', ',
      )

const filters = (x: Expect | AiSearchInput) =>
  join(FILTER_KEYS.map((k) => (x[k] == null ? null : `${k}: ${value(x[k])}`)))

export const FIELDS: Record<
  string,
  (expect: Expect, result: ParsedResult | undefined, today: string) => Slice
> = {
  gradeAction: (e, r) => ({
    exp: e.action ? `"${e.action}"` : NONE,
    got: r ? `"${r.action}"` : 'no response',
  }),

  gradeSearchType: (e, r) => ({
    exp: e.search_type ? `"${e.search_type}"` : NONE,
    got: paramsOf(r) ? `"${paramsOf(r)!.search_type}"` : noParams(r),
  }),

  gradeOrigin: (e, r) => {
    const p = paramsOf(r)
    return {
      exp: expectTrips(e, (t) => expectLoc(t.departure)),
      got: p ? actualTrips(p, (t) => actualLoc(t.departure)) : noParams(r),
    }
  },

  gradeDestination: (e, r) => {
    const p = paramsOf(r)
    return {
      exp: expectTrips(e, (t) => expectLoc(t.arrival)),
      got: p ? actualTrips(p, (t) => actualLoc(t.arrival)) : noParams(r),
    }
  },

  gradeDateRange: (e, r) => {
    const p = paramsOf(r)
    return {
      exp: expectTrips(e, (t) => join([t.departure_date, t.return_date && `return ${t.return_date}`])),
      got: p
        ? actualTrips(p, (t) => join([t.departure_date, t.return_date && `return ${t.return_date}`]))
        : noParams(r),
    }
  },

  gradeDuration: (e, r) => {
    const p = paramsOf(r)
    return {
      exp: expectTrips(e, (t) => t.duration ?? NONE),
      got: p ? actualTrips(p, (t) => t.duration ?? 'null') : noParams(r),
    }
  },

  gradePassengers: (e, r) => {
    const p = paramsOf(r)
    return { exp: passengers(e.passengers), got: p ? passengers(p.passengers) : noParams(r) }
  },

  gradeCabin: (e, r) => {
    const p = paramsOf(r)
    return {
      exp: e.cabins ? `"${e.cabins}"` : 'null',
      got: p ? (p.cabins ? `"${p.cabins}"` : 'null') : noParams(r),
    }
  },

  gradeFilters: (e, r) => {
    const p = paramsOf(r)
    return { exp: filters(e), got: p ? filters(p) : noParams(r) }
  },

  gradeNoInventedParams: (e, r) => {
    const p = paramsOf(r)
    const unasserted = NULLABLE.filter((k) => e[k] === undefined)
    const invented = p && join(unasserted.map((k) => (p[k] == null ? null : `${k}: ${value(p[k])}`)))
    return {
      exp: `null for ${unasserted.length} unasserted field${unasserted.length === 1 ? '' : 's'}`,
      got: !p ? noParams(r) : invented === NONE ? 'all null' : invented!,
    }
  },

  gradeDateSanity: (_e, r, today) => {
    const p = paramsOf(r)
    return {
      exp: `departure ≥ ${today}`,
      got: p ? actualTrips(p, (t) => t.departure_date ?? 'null') : noParams(r),
    }
  },

  gradeTripShape: (e, r) => {
    const p = paramsOf(r)
    const n = e.trips?.length
    const both = p?.trips.some((t) => t.return_date && t.duration)
    return {
      exp: n ? `${n} trip${n === 1 ? '' : 's'}, duration xor return_date` : 'duration xor return_date',
      got: p
        ? `${p.trips.length} trip${p.trips.length === 1 ? '' : 's'}${both ? ', a leg sets both' : ''}`
        : noParams(r),
    }
  },
}

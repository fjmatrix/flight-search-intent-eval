const MS_PER_DAY = 86_400_000
const DATE = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/

/**
 * 'MM/DD/YY' or 'MM/DD/YYYY' to a day number. NaN for anything else — the schema
 * has its date `pattern` commented out, so the format is not actually guaranteed
 * and a malformed date has to be gradeable rather than fatal.
 */
export function toDay(date: string): number {
  const match = DATE.exec(date.trim())
  if (!match) return NaN
  const [, month, day, year] = match
  const fullYear = year!.length === 2 ? 2000 + Number(year) : Number(year)
  return Date.UTC(fullYear, Number(month) - 1, Number(day)) / MS_PER_DAY
}

/** 'MM/DD/YY' or 'MM/DD/YY-MM/DD/YY' to [first, last] day numbers. */
export function toRange(value: string): [number, number] {
  const [from, to = from] = value.split('-')
  return [toDay(from ?? ''), toDay(to ?? '')]
}

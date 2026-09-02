/** Turns the run files into the numbers and rows the page shows. */

import { FIELDS } from './fields.ts'
import { GRADERS } from '../grade.ts'
import type { Pricing, ResultCase, ResultsFile, RunRecord } from './read.ts'
import type { ParsedResult } from '../types.ts'

export interface Missed {
  grader: string
  exp: string
  got: string
}

export interface FailRow {
  /** The model view this row belongs to, not the model name: see ModelView.key. */
  key: string
  model: string
  id: string
  lang: string
  text: string
  tags: string[]
  /** At least one repeat produced no grades at all. */
  errored: boolean
  missed: Missed[]
}

export interface Tally {
  passed: number
  of: number
}

export interface ModelView {
  /**
   * One results file. A run holds the same model at several efforts, so the
   * name alone does not identify a row — this is the file's basename.
   */
  key: string
  model: string
  prompt: string
  effort: string | null
  passed: number
  errors: number
  dims: Record<string, Tally>
  tags: Record<string, Tally>
  langs: Record<string, Tally>
  usage: { input: number; output: number; reasoning: number }
  tokens: number
  /** null when eval.config.json carried no price for this model. */
  cost: number | null
  latencyP50: number
}

export interface ViewData {
  runId: string
  today: string
  prompt: string
  repeats: number
  grading: { embedding_model: string; similarity_threshold: number }
  total: number
  calls: number
  graders: string[]
  tags: string[]
  langs: string[]
  countByLang: Record<string, number>
  models: ModelView[]
  fails: FailRow[]
}

/**
 * Recomputed from the grades rather than read off `run.passed`, so a results
 * file written when a since-removed grader was scoring is judged by the
 * dimensions this build has. A run that produced no grades never passes.
 */
const casePassed = (c: ResultCase, graders: string[]) =>
  c.runs.length > 0 &&
  c.runs.every((r) => r.grades && graders.every((g) => r.grades![g] !== false))

const resultOf = (r: RunRecord) => (r.actual as { result?: ParsedResult } | null)?.result

/**
 * Cached and written input bill at the read and write rates and are both already
 * inside `input`; reasoning bills as output and is already inside `output`.
 */
function costOf(
  sum: { input: number; output: number; cached: number; written: number },
  p: Pricing | null,
) {
  if (!p) return null
  // `input` holds all three input terms; the other two are subtracted back out
  // so each is priced once, at its own rate.
  const plain = sum.input - sum.cached - sum.written
  return (
    (plain * p.input +
      sum.cached * p.cache_read +
      sum.written * p.cache_write +
      sum.output * p.output) /
    1e6
  )
}

function median(ns: number[]): number {
  if (ns.length === 0) return 0
  const sorted = [...ns].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/**
 * Grader names in the order gradeAll wrote them, taken from the first graded run,
 * minus any this build no longer defines. An older results file can carry grades
 * from a grader that has since been removed; the dashboard shows the dimensions
 * that exist now.
 */
function graderOrder(files: ResultsFile[]): string[] {
  for (const file of files) {
    for (const c of file.cases) {
      for (const run of c.runs) {
        if (run.grades) return Object.keys(run.grades).filter((g) => g in GRADERS)
      }
    }
  }
  return []
}

/** The tags naming a search type, in the order the schema lists them. */
const SEARCH_TYPE_TAGS = ['oneway', 'roundtrip', 'multi']

/**
 * Columns run from the most common tag to the least, except that the search-type
 * tags rank as one block — placed where the most common of them falls, in schema
 * order inside — so the three read side by side rather than split apart by how
 * often each shape shows up.
 */
function orderTags(tags: string[], cases: ResultCase[]): string[] {
  const count = (tag: string) => cases.filter((c) => c.tags.includes(tag)).length
  const block = SEARCH_TYPE_TAGS.filter((tag) => tags.includes(tag))
  const blockRank = Math.max(0, ...block.map(count))
  const rank = (tag: string) => (block.includes(tag) ? blockRank : count(tag))
  // -1 for every tag outside the block, so two of those keep the sort stable.
  const within = (tag: string) => block.indexOf(tag)
  return tags.sort((a, b) => rank(b) - rank(a) || within(a) - within(b))
}

function tally(cases: ResultCase[], graders: string[], keep: (c: ResultCase) => boolean): Tally {
  const subset = cases.filter(keep)
  return { passed: subset.filter((c) => casePassed(c, graders)).length, of: subset.length }
}

export function build(files: ResultsFile[]): ViewData {
  const first = files[0]!
  const cases = first.cases
  const graders = graderOrder(files)
  const tags = orderTags([...new Set(files.flatMap((f) => f.cases.flatMap((c) => c.tags)))], cases)
  const langs = [...new Set(cases.map((c) => c.lang))].sort()

  const models: ModelView[] = []
  const fails: FailRow[] = []

  for (const file of files) {
    const key = [file.model, file.effort].filter(Boolean).join('-')
    // Dimensions count per repeat, the same denominator run.ts prints.
    const dims: Record<string, Tally> = Object.fromEntries(graders.map((g) => [g, { passed: 0, of: 0 }]))
    const sum = { input: 0, output: 0, reasoning: 0, cached: 0, written: 0 }
    let errors = 0
    let tokens = 0
    let calls = 0
    const latencies: number[] = []

    for (const c of file.cases) {
      for (const run of c.runs) {
        calls++
        tokens += run.usage.total
        sum.input += run.usage.input
        sum.output += run.usage.output
        sum.reasoning += run.usage.reasoning ?? 0
        sum.cached += run.usage.cached
        // Runs recorded before this field existed carry no cache-write term.
        sum.written += run.usage.written ?? 0
        latencies.push(run.latency_ms)
        if (!run.grades) {
          errors++
          continue
        }
        for (const g of graders) {
          const grade = run.grades[g]
          if (grade == null) continue
          dims[g]!.of++
          if (grade) dims[g]!.passed++
        }
      }

      if (casePassed(c, graders)) continue

      // The count of passing repeats orders the list — a dimension that failed
      // every repeat leads — but only the grader and its two sides are shown.
      const missed: (Missed & { passed: number })[] = []
      for (const g of graders) {
        const scored = c.runs.filter((r) => r.grades?.[g] != null)
        const passed = scored.filter((r) => r.grades![g] === true).length
        if (scored.length === 0 || passed === scored.length) continue
        const failing = c.runs.find((r) => r.grades?.[g] === false)!
        const slice = FIELDS[g]?.(c.expect, resultOf(failing), file.today)
        missed.push({ grader: g, passed, exp: slice?.exp ?? '—', got: slice?.got ?? '—' })
      }
      missed.sort((a, b) => a.passed - b.passed)

      fails.push({
        key,
        model: file.model,
        id: c.id,
        lang: c.lang,
        text: c.text,
        tags: c.tags,
        errored: c.runs.some((r) => !r.grades),
        missed: missed.map(({ grader, exp, got }) => ({ grader, exp, got })),
      })
    }

    models.push({
      key,
      model: file.model,
      prompt: file.prompt,
      effort: file.effort ?? null,
      passed: file.cases.filter((c) => casePassed(c, graders)).length,
      errors,
      dims,
      tags: Object.fromEntries(tags.map((t) => [t, tally(file.cases, graders, (c) => c.tags.includes(t))])),
      langs: Object.fromEntries(langs.map((l) => [l, tally(file.cases, graders, (c) => c.lang === l)])),
      usage: {
        input: Math.round(sum.input / calls),
        output: Math.round(sum.output / calls),
        reasoning: Math.round(sum.reasoning / calls),
      },
      tokens,
      cost: costOf(sum, file.pricing ?? null),
      latencyP50: median(latencies),
    })
  }

  models.sort((a, b) => b.passed - a.passed)

  return {
    runId: first.run_id,
    today: first.today,
    prompt: [...new Set(files.map((f) => f.prompt))].join(' · '),
    repeats: first.repeats,
    grading: first.grading,
    total: cases.length,
    calls: cases.length * first.repeats * files.length,
    graders,
    tags,
    langs,
    countByLang: Object.fromEntries(langs.map((l) => [l, cases.filter((c) => c.lang === l).length])),
    models,
    fails,
  }
}

/** Turns the run files into the numbers and rows the page shows. */

import { FIELDS } from './fields.ts'
import type { Pricing, ResultCase, ResultsFile, RunRecord } from './read.ts'
import type { ParsedResult } from '../types.ts'

export interface Missed {
  grader: string
  /** Repeats that passed, out of the repeats that scored this dimension. */
  passed: number
  of: number
  exp: string
  got: string
}

export interface FailRow {
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

const casePassed = (c: ResultCase) => c.runs.length > 0 && c.runs.every((r) => r.passed === true)
const resultOf = (r: RunRecord) => (r.actual as { result?: ParsedResult } | null)?.result

/**
 * Cached input bills at the read rate and is already inside `input`; reasoning
 * bills as output and is already inside `output`. Nothing reports cache writes
 * yet, so `cache_write` goes unused until a provider that charges for it lands.
 */
function costOf(sum: { input: number; output: number; cached: number }, p: Pricing | null) {
  if (!p) return null
  return ((sum.input - sum.cached) * p.input + sum.cached * p.cache_read + sum.output * p.output) / 1e6
}

function median(ns: number[]): number {
  if (ns.length === 0) return 0
  const sorted = [...ns].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/** Grader names in the order gradeAll wrote them, taken from the first graded run. */
function graderOrder(files: ResultsFile[]): string[] {
  for (const file of files) {
    for (const c of file.cases) {
      for (const run of c.runs) if (run.grades) return Object.keys(run.grades)
    }
  }
  return []
}

function tally(cases: ResultCase[], keep: (c: ResultCase) => boolean): Tally {
  const subset = cases.filter(keep)
  return { passed: subset.filter(casePassed).length, of: subset.length }
}

export function build(files: ResultsFile[]): ViewData {
  const first = files[0]!
  const cases = first.cases
  const graders = graderOrder(files)
  const tags = [...new Set(files.flatMap((f) => f.cases.flatMap((c) => c.tags)))].sort(
    (a, b) =>
      cases.filter((c) => c.tags.includes(b)).length - cases.filter((c) => c.tags.includes(a)).length,
  )
  const langs = [...new Set(cases.map((c) => c.lang))].sort()

  const models: ModelView[] = []
  const fails: FailRow[] = []

  for (const file of files) {
    // Dimensions count per repeat, the same denominator run.ts prints.
    const dims: Record<string, Tally> = Object.fromEntries(graders.map((g) => [g, { passed: 0, of: 0 }]))
    const sum = { input: 0, output: 0, reasoning: 0, cached: 0 }
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

      if (casePassed(c)) continue

      const missed: Missed[] = []
      for (const g of graders) {
        const scored = c.runs.filter((r) => r.grades?.[g] != null)
        const passed = scored.filter((r) => r.grades![g] === true).length
        if (scored.length === 0 || passed === scored.length) continue
        const failing = c.runs.find((r) => r.grades?.[g] === false)!
        const slice = FIELDS[g]?.(c.expect, resultOf(failing), file.today)
        missed.push({
          grader: g,
          passed,
          of: scored.length,
          exp: slice?.exp ?? '—',
          got: slice?.got ?? '—',
        })
      }
      missed.sort((a, b) => a.passed - b.passed)

      fails.push({
        model: file.model,
        id: c.id,
        lang: c.lang,
        text: c.text,
        tags: c.tags,
        errored: c.runs.some((r) => !r.grades),
        missed,
      })
    }

    models.push({
      model: file.model,
      prompt: file.prompt,
      effort: file.effort ?? null,
      passed: file.cases.filter(casePassed).length,
      errors,
      dims,
      tags: Object.fromEntries(tags.map((t) => [t, tally(file.cases, (c) => c.tags.includes(t))])),
      langs: Object.fromEntries(langs.map((l) => [l, tally(file.cases, (c) => c.lang === l)])),
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

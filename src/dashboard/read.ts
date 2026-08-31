/** Reads a run directory: one JSON per model, in the shape `run.ts` writes. */

import fs from 'node:fs'
import type { Case } from '../types.ts'
import type { Grade } from '../grade.ts'
import type { RunStatus, TokenUsage } from '../providers/types.ts'
import type { GradingConfig } from '../semantic.ts'

export interface RunRecord {
  repeat: number
  status: RunStatus
  error?: string
  /** Absent when the call never produced a parseable response. */
  grades?: Record<string, Grade>
  passed?: boolean
  actual: unknown
  usage: TokenUsage
  latency_ms: number
}

export interface ResultCase extends Case {
  tags: string[]
  runs: RunRecord[]
}

export interface Pricing {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

export interface ResultsFile {
  run_id: string
  today: string
  model: string
  /** Reasoning effort the run was made at, null when the model has no such knob. */
  effort: string | null
  prompt: string
  repeats: number
  grading: GradingConfig
  /** USD per million tokens, copied from eval.config.json at run time. */
  pricing: Pricing | null
  by_tag: Record<string, { passed: number; scored: number }>
  cases: ResultCase[]
}

/**
 * Every `*.json` in the directory, sorted by filename, one model each. The files
 * are not compared to one another: a directory holding runs from two anchor
 * dates or two prompt versions is read as though it held one.
 */
export function readRun(dir: string): ResultsFile[] {
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  if (names.length === 0) throw new Error(`no *.json in ${dir}`)
  return names.map((name) => JSON.parse(fs.readFileSync(`${dir}/${name}`, 'utf8')) as ResultsFile)
}

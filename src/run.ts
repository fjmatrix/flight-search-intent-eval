import fs from 'node:fs'
import path from 'node:path'
import { gradeAll, GRADERS, type Grade, type GradeContext } from './grade.ts'
import { getProvider } from './providers/index.ts'
import type { JsonSchema, ModelResponse, RunStatus } from './providers/types.ts'
import {
  NULLABLE_PARAM_FIELDS,
  type AiSearchInput,
  type Case,
  type Expect,
  type ParsedResult,
} from './types.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // No .env; rely on the ambient environment.
}

// ---------------------------------------------------------------- config

interface ProviderConfig {
  model: string
  max_tokens: number
  params: Record<string, unknown>
}

interface EvalConfig {
  prompt: string
  repeats: number
  concurrency: number
  max_attempts: number
  providers: Record<string, ProviderConfig>
  pricing: Record<string, unknown>
}

interface Options {
  providers: string[]
  langs: string[] | null
  repeats: number
  model: string | null
  prompt: string
  limit: number | null
  concurrency: number
  checkSchema: boolean
  dryRun: boolean
}

function parseArgs(argv: string[], config: EvalConfig): Options {
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg?.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next)
      i++
    } else {
      flags.set(key, true)
    }
  }

  const str = (key: string): string | null => {
    const value = flags.get(key)
    return typeof value === 'string' ? value : null
  }
  const int = (key: string, fallback: number): number => {
    const value = str(key)
    if (value === null) return fallback
    const parsed = Number.parseInt(value, 10)
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`--${key} must be a positive integer, got "${value}"`)
    }
    return parsed
  }

  const providerArg = str('provider')
  const providers = providerArg
    ? providerArg.split(',').map((name) => name.trim())
    : Object.keys(config.providers)
  const langArg = str('lang')
  const model = str('model')

  if (model && providers.length !== 1) {
    throw new Error('--model requires exactly one --provider')
  }
  for (const name of providers) {
    if (!config.providers[name]) {
      throw new Error(
        `provider "${name}" is not in eval.config.json (has: ${Object.keys(config.providers).join(', ')})`,
      )
    }
  }

  return {
    providers,
    langs: langArg ? langArg.split(',').map((lang) => lang.trim()) : null,
    repeats: int('repeats', config.repeats),
    model,
    prompt: str('prompt') ?? config.prompt,
    limit: str('limit') ? int('limit', 0) : null,
    concurrency: int('concurrency', config.concurrency),
    checkSchema: flags.get('check-schema') === true,
    dryRun: flags.get('dry-run') === true,
  }
}

// ---------------------------------------------------------------- loading

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const ACTIONS = new Set(['get_tickets', 'handle_invalid'])
const SEARCH_TYPES = new Set(['oneway', 'roundtrip', 'multi'])
const NULLABLE = new Set<string>(NULLABLE_PARAM_FIELDS)

/**
 * Loud on malformed cases. A mistyped field name in `must_be_null` would otherwise
 * grade as a silent failure against every model, which reads as a model problem.
 */
function loadCases(langs: string[] | null): Case[] {
  const files = fs
    .readdirSync('dataset')
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
  const cases: Case[] = []
  const seen = new Set<string>()

  for (const file of files) {
    const lang = path.basename(file, '.jsonl')
    if (langs && !langs.includes(lang)) continue
    const lines = fs.readFileSync(path.join('dataset', file), 'utf8').split('\n')

    lines.forEach((line, index) => {
      if (!line.trim()) return
      const where = `dataset/${file}:${index + 1}`
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        throw new Error(`${where}: invalid JSON — ${(error as Error).message}`)
      }
      if (!isRecord(parsed)) throw new Error(`${where}: case must be an object`)

      const { id, text, expect } = parsed
      if (typeof id !== 'string' || !id) throw new Error(`${where}: missing id`)
      if (typeof text !== 'string' || !text) throw new Error(`${where}: missing text`)
      if (parsed.lang !== lang) {
        throw new Error(`${where}: lang "${String(parsed.lang)}" does not match filename`)
      }
      const key = `${lang}/${id}`
      if (seen.has(key)) throw new Error(`${where}: duplicate id "${id}"`)
      seen.add(key)

      if (!isRecord(expect)) throw new Error(`${where}: missing expect`)
      if (expect.action !== undefined && !ACTIONS.has(String(expect.action))) {
        throw new Error(`${where}: unknown action "${String(expect.action)}"`)
      }
      if (expect.search_type !== undefined && !SEARCH_TYPES.has(String(expect.search_type))) {
        throw new Error(`${where}: unknown search_type "${String(expect.search_type)}"`)
      }
      if (expect.must_be_null !== undefined) {
        if (!Array.isArray(expect.must_be_null)) {
          throw new Error(`${where}: must_be_null must be an array`)
        }
        for (const field of expect.must_be_null) {
          if (!NULLABLE.has(String(field))) {
            throw new Error(
              `${where}: must_be_null field "${String(field)}" is not a nullable top-level param (allowed: ${[...NULLABLE].join(', ')})`,
            )
          }
        }
      }

      cases.push({ id, lang, text, expect: expect as Expect })
    })
  }

  if (cases.length === 0) throw new Error('no cases matched')
  return cases
}

// ---------------------------------------------------------------- envelope

/**
 * The `{ result: ... }` envelope is this eval's contract, not any vendor's, so it is
 * validated here rather than in an adapter. Structural only — full JSON Schema
 * validation arrives with gradeSchema in M2.
 */
function parseEnvelope(output: unknown): ParsedResult | null {
  if (!isRecord(output) || !isRecord(output.result)) return null
  const result = output.result

  if (result.action === 'handle_invalid') {
    return typeof result.reason === 'string'
      ? { action: 'handle_invalid', reason: result.reason }
      : null
  }
  if (result.action === 'get_tickets' && isRecord(result.params)) {
    const params = result.params
    const required = [
      'search_type',
      'passengers',
      'cabins',
      'max_stops',
      'max_price',
      'flight_duration',
      'connecting_airports',
      'bags',
      'trips',
    ]
    if (!required.every((field) => field in params)) return null
    if (!Array.isArray(params.trips)) return null
    if (!SEARCH_TYPES.has(String(params.search_type))) return null
    return { action: 'get_tickets', params: params as unknown as AiSearchInput }
  }
  return null
}

// ---------------------------------------------------------------- schema parity

function diffSchema(original: unknown, rendered: unknown, at = '$'): string[] {
  if (isRecord(original) && isRecord(rendered)) {
    const notes: string[] = []
    for (const key of Object.keys(original)) {
      if (!(key in rendered)) {
        notes.push(`dropped ${at}.${key}`)
        continue
      }
      notes.push(...diffSchema(original[key], rendered[key], `${at}.${key}`))
    }
    for (const key of Object.keys(rendered)) {
      if (!(key in original)) notes.push(`added ${at}.${key}`)
    }
    return notes
  }
  if (Array.isArray(original) && Array.isArray(rendered)) {
    if (original.length !== rendered.length) {
      return [`length ${at}: ${original.length} → ${rendered.length}`]
    }
    return original.flatMap((item, index) =>
      diffSchema(item, rendered[index], `${at}[${index}]`),
    )
  }
  if (JSON.stringify(original) !== JSON.stringify(rendered)) {
    return [`changed ${at}: ${JSON.stringify(original)} → ${JSON.stringify(rendered)}`]
  }
  return []
}

function checkSchemaParity(
  providerNames: string[],
  schema: JsonSchema,
): Record<string, 'exact' | string[]> {
  const parity: Record<string, 'exact' | string[]> = {}
  for (const name of providerNames) {
    const rendered = getProvider(name).toProviderSchema(structuredClone(schema))
    const notes = diffSchema(schema, rendered)
    parity[name] = notes.length === 0 ? 'exact' : notes
  }
  return parity
}

// ---------------------------------------------------------------- run

interface RunRecord {
  provider: string
  repeat: number
  status: RunStatus
  error?: string
  grades?: Record<string, Grade>
  actual: unknown
  raw_text?: string
  usage: ModelResponse['usage']
  latency_ms: number
  attempts: number
  meta: ModelResponse['meta']
}

interface CaseRecord {
  id: string
  lang: string
  text: string
  expect: Expect
  runs: RunRecord[]
}

interface Task {
  caseIndex: number
  provider: string
  repeat: number
}

async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      const item = items[index]
      if (item === undefined) return
      await worker(item)
    }
  })
  await Promise.all(runners)
}

function todayMMDDYYYY(date = new Date()): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${mm}/${dd}/${date.getFullYear()}`
}

function runId(date = new Date()): string {
  const iso = date.toISOString()
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`
}

// ---------------------------------------------------------------- report

function pct(pass: number, total: number): string {
  return total === 0 ? '  — ' : `${Math.round((pass / total) * 100)}%`.padStart(4)
}

function summarize(cases: CaseRecord[], providerNames: string[]): void {
  for (const provider of providerNames) {
    const runs = cases.flatMap((entry) =>
      entry.runs.filter((run) => run.provider === provider),
    )
    const graded = runs.filter((run) => run.grades)
    const errors = runs.filter((run) => run.status !== 'ok')

    console.log(`\n  ${provider}`)
    console.log('  grader              pass')
    let overallPass = 0
    let overallTotal = 0
    for (const name of Object.keys(GRADERS)) {
      let pass = 0
      let total = 0
      for (const run of graded) {
        const grade = run.grades?.[name]
        if (grade === null || grade === undefined) continue
        total++
        if (grade) pass++
      }
      overallPass += pass
      overallTotal += total
      console.log(
        `  ${name.padEnd(18)}${String(pass).padStart(3)}/${String(total).padEnd(3)} ${pct(pass, total)}`,
      )
    }
    console.log('  ' + '-'.repeat(32))
    console.log(
      `  ${'overall'.padEnd(18)}${String(overallPass).padStart(3)}/${String(overallTotal).padEnd(3)} ${pct(overallPass, overallTotal)}`,
    )

    const usage = runs.reduce(
      (acc, run) => ({
        input: acc.input + run.usage.input,
        output: acc.output + run.usage.output,
        reasoning: acc.reasoning + (run.usage.reasoning ?? 0),
        cache_read: acc.cache_read + run.usage.cache_read,
        total: acc.total + run.usage.total,
      }),
      { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 },
    )
    const latencies = runs.map((run) => run.latency_ms).sort((a, b) => a - b)
    const p50 = latencies[Math.floor(latencies.length / 2)] ?? 0
    const max = latencies.at(-1) ?? 0
    const retried = runs.filter((run) => run.attempts > 1).length

    console.log(
      `\n  runs ${runs.length}   ok ${runs.length - errors.length}   errors ${errors.length}   retried ${retried}`,
    )
    console.log(
      `  tokens  in ${usage.input.toLocaleString()}  out ${usage.output.toLocaleString()}  reasoning ${usage.reasoning.toLocaleString()}  cached ${usage.cache_read.toLocaleString()}  total ${usage.total.toLocaleString()}`,
    )
    console.log(`  latency  p50 ${p50}ms  max ${max}ms`)

    for (const entry of cases) {
      for (const run of entry.runs) {
        if (run.provider !== provider || run.status === 'ok') continue
        console.log(`  ! ${entry.lang}/${entry.id} #${run.repeat} ${run.status}: ${run.error ?? ''}`)
      }
    }
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const config = readJson<EvalConfig>('eval.config.json')
  const options = parseArgs(process.argv.slice(2), config)
  const schema = readJson<JsonSchema>('schema/search-input.json')
  const parity = checkSchemaParity(options.providers, schema)

  if (options.checkSchema) {
    console.log('schema parity — schema/search-input.json\n')
    for (const [name, result] of Object.entries(parity)) {
      if (result === 'exact') {
        console.log(`  ${name.padEnd(10)} exact`)
      } else {
        console.log(`  ${name.padEnd(10)} ${result.length} difference(s)`)
        for (const note of result) console.log(`             ${note}`)
      }
    }
    return
  }

  const promptFile = path.join('prompts', `${options.prompt}.txt`)
  const promptTemplate = fs.readFileSync(promptFile, 'utf8')
  if (!promptTemplate.includes('{{todaysDate}}')) {
    throw new Error(`${promptFile} has no {{todaysDate}} placeholder`)
  }
  const today = todayMMDDYYYY()
  const system = promptTemplate.replaceAll('{{todaysDate}}', today)

  let cases = loadCases(options.langs)
  if (options.limit !== null) cases = cases.slice(0, options.limit)

  const records: CaseRecord[] = cases.map((entry) => ({ ...entry, runs: [] }))
  const tasks: Task[] = []
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
    for (const provider of options.providers) {
      for (let repeat = 1; repeat <= options.repeats; repeat++) {
        tasks.push({ caseIndex, provider, repeat })
      }
    }
  }

  const id = runId()
  const configBlock = {
    prompt: options.prompt,
    repeats: options.repeats,
    providers: Object.fromEntries(
      options.providers.map((name) => {
        const provider = config.providers[name]!
        return [
          name,
          { ...provider, model: options.model ?? provider.model },
        ]
      }),
    ),
  }

  console.log(`flight-search-eval  run ${id}`)
  console.log(
    `providers ${options.providers.join(', ')}  prompt ${options.prompt}  repeats ${options.repeats}  today ${today}`,
  )
  console.log(`${cases.length} cases × ${options.repeats} repeats = ${tasks.length} calls`)

  if (options.dryRun) {
    const first = cases[0]!
    console.log('\n--dry-run: no calls made. First request:\n')
    console.log(JSON.stringify({ system, user: first.text, ...configBlock.providers }, null, 2))
    return
  }

  const ctx: GradeContext = { today }
  const slots = new Map<string, RunRecord>()

  await pool(tasks, options.concurrency, async (task) => {
    const entry = cases[task.caseIndex]!
    const providerConfig = config.providers[task.provider]!
    const response = await getProvider(task.provider).call({
      system,
      user: entry.text,
      schema,
      model: options.model ?? providerConfig.model,
      maxTokens: providerConfig.max_tokens,
      params: providerConfig.params,
      maxAttempts: config.max_attempts,
    })

    const record: RunRecord = {
      provider: task.provider,
      repeat: task.repeat,
      status: response.status,
      actual: response.output,
      usage: response.usage,
      latency_ms: response.latency_ms,
      attempts: response.attempts,
      meta: response.meta,
      ...(response.error !== undefined ? { error: response.error } : {}),
      ...(response.raw_text !== undefined ? { raw_text: response.raw_text } : {}),
    }

    if (response.status === 'ok') {
      const parsed = parseEnvelope(response.output)
      if (parsed) {
        record.grades = gradeAll(parsed, entry.expect, ctx)
      } else {
        record.status = 'schema_error'
        record.error = 'output did not match the get_tickets / handle_invalid envelope'
      }
    }

    slots.set(`${task.caseIndex}:${task.provider}:${task.repeat}`, record)
    process.stdout.write('.')
  })

  for (const task of tasks) {
    const record = slots.get(`${task.caseIndex}:${task.provider}:${task.repeat}`)
    if (record) records[task.caseIndex]!.runs.push(record)
  }
  console.log('')

  const outDir = path.join('results', id)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(
    path.join(outDir, 'results.json'),
    JSON.stringify(
      { run_id: id, today, config: configBlock, schema_parity: parity, cases: records },
      null,
      2,
    ) + '\n',
  )

  summarize(records, options.providers)
  console.log(`\n  → ${path.join(outDir, 'results.json')}`)
}

main().catch((error: unknown) => {
  console.error(`\nerror: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

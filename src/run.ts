import fs from 'node:fs'
import { readRun } from './dashboard/read.ts'
import { page } from './dashboard/render.ts'
import { build } from './dashboard/view.ts'
import { GRADERS, gradeAll, type Grade } from './grade.ts'
import { anthropic } from './providers/anthropic.ts'
import { openai } from './providers/openai.ts'
import type { Provider, RunStatus, TokenUsage } from './providers/types.ts'
import type { GradingConfig } from './semantic.ts'
import type { Case, ParsedResult } from './types.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // No .env; rely on the ambient environment.
}

interface Config {
  prompt: string
  repeats: number
  /** Pinned MM/DD/YYYY. The dataset's expected dates are written against it. */
  today?: string
  /** One entry per leaderboard row: a model at a reasoning effort. */
  models: ModelEntry[]
  /** Embedding model and threshold for fuzzy locations. Changing either rescores every one. */
  grading: GradingConfig
  /** USD per million tokens, per model. null when the price is not known yet. */
  pricing: Record<string, Pricing | null>
}

interface ModelEntry {
  /** Key into ADAPTERS below. */
  provider: string
  model: string
  max_tokens: number
  effort?: string
  /** Vendor-specific knobs the adapter passes through untouched. */
  params: Record<string, unknown>
}

interface Pricing {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

// --- arguments: --key value, every flag takes a value ------------------------

const args: Record<string, string> = {}
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i]!.slice(2)] = process.argv[i + 1] ?? ''
}

// --- load --------------------------------------------------------------------

const config: Config = JSON.parse(fs.readFileSync('eval.config.json', 'utf8'))
const grading = config.grading

const promptName = args.prompt ?? config.prompt
const repeats = Number(args.repeats ?? config.repeats)

const now = new Date()
const iso = now.toISOString()
const runId = `${iso.slice(0, 10)}T${iso.slice(11, 16).replace(':', '')}Z`

// The pin is the date the prompt is told is today, and the one gradeDateSanity
// measures a departure against. Every case's expected dates are written for this
// pin, so there is no fallback to the real date: a run under a different pin
// would grade against answers that were correct for another day.
const pin = args.today ?? config.today
if (pin === undefined) {
  throw new Error('no pinned date: set "today" in eval.config.json or pass --today MM/DD/YYYY')
}
if (!/^\d{2}\/\d{2}\/\d{4}$/.test(pin)) {
  throw new Error(`today must be MM/DD/YYYY, got "${pin}"`)
}
// Bound after the checks so it stays a plain string inside runModel below.
const today: string = pin

const system = fs
  .readFileSync(`prompts/${promptName}.txt`, 'utf8')
  .replaceAll('{{todaysDate}}', today)
const schema = JSON.parse(fs.readFileSync('schema/search-input.json', 'utf8'))

const files = args.lang
  ? [`${args.lang}.jsonl`]
  : fs.readdirSync('dataset').filter((file) => file.endsWith('.jsonl')).sort()

let cases: Case[] = files.flatMap((file) =>
  fs
    .readFileSync(`dataset/${file}`, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Case),
)
if (args.limit) cases = cases.slice(0, Number(args.limit))

// --- run ---------------------------------------------------------------------

interface Run {
  repeat: number
  status: RunStatus
  error?: string
  grades?: Record<string, Grade>
  passed?: boolean
  actual: unknown
  usage: TokenUsage
  latency_ms: number
}

const ADAPTERS: Record<string, Provider> = { openai, anthropic }

// --model runs one entry out of the config rather than overriding its id.
const entries = args.model ? config.models.filter((e) => e.model === args.model) : config.models
if (entries.length === 0) {
  throw new Error(`no model matches "${args.model}" in eval.config.json`)
}

console.log(`flight-search-eval  run ${runId}`)
console.log(`prompt ${promptName}  repeats ${repeats}  pin ${today}`)
console.log(
  `grading ${grading.embedding_model}  similarity >= ${grading.similarity_threshold}`,
)
console.log(
  `${cases.length} cases × ${repeats} repeats × ${entries.length} model${entries.length === 1 ? '' : 's'} = ${cases.length * repeats * entries.length} calls`,
)

for (const entry of entries) await runModel(entry)

// Every model has written its JSON by now, so the page covers the whole run.
const dashboard = `results/${runId}/index.html`
try {
  fs.writeFileSync(dashboard, page(build(readRun(`results/${runId}`))))
  console.log(`\n  → ${dashboard}`)
} catch (error) {
  // The results are already on disk, so a render bug is not a failed eval.
  // Leaving no page at all beats leaving one an earlier render wrote.
  fs.rmSync(dashboard, { force: true })
  console.error(`\n  dashboard failed: ${(error as Error).message}`)
  console.error(`  results are intact — npm run dashboard -- results/${runId}`)
}

async function runModel(entry: ModelEntry): Promise<void> {
  const provider = ADAPTERS[entry.provider]
  if (!provider) throw new Error(`unknown provider "${entry.provider}" for ${entry.model}`)
  const model = entry.model
  const effort = entry.effort ?? null
  const pricing = config.pricing?.[model] ?? null
  console.log(`\n${model}${effort ? ` · ${effort}` : ''}  via ${entry.provider}`)

  const results: (Case & { tags: string[]; runs: Run[] })[] = []

  for (const testCase of cases) {
    const runs: Run[] = []
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const response = await provider.call({
        system,
        user: testCase.text,
        schema,
        model,
        maxTokens: entry.max_tokens,
        effort,
        params: entry.params,
      })

      // strict: true means an 'ok' response already matches the schema.
      const result = (response.output as { result: ParsedResult } | null)?.result

      const grades = result ? await gradeAll(result, testCase.expect, { today, grading }) : undefined

      runs.push({
        repeat,
        status: response.status,
        ...(response.error ? { error: response.error } : {}),
        ...(grades
          ? { grades, passed: Object.values(grades).every((grade) => grade !== false) }
          : {}),
        actual: response.output,
        usage: response.usage,
        latency_ms: response.latency_ms,
      })
      process.stdout.write(response.status === 'ok' ? '.' : 'x')
    }
    results.push({ ...testCase, tags: testCase.tags ?? [], runs })
  }

  // --- write and report --------------------------------------------------------

  // A run counts for every tag its case carries. Runs that never scored — an API
  // error, an unparseable response — are out of both halves of the fraction.
  const byTag: Record<string, { passed: number; scored: number }> = {}
  for (const entry of results) {
    for (const tag of entry.tags) {
      const bucket = (byTag[tag] ??= { passed: 0, scored: 0 })
      for (const run of entry.runs) {
        if (run.passed === undefined) continue
        bucket.scored++
        if (run.passed) bucket.passed++
      }
    }
  }

  const outDir = `results/${runId}`
  // One file per model and effort, so a directory holds a whole comparison and a
  // re-run of one model leaves the others alone. Slashes appear in some model ids.
  const outFile = `${[model, effort].filter(Boolean).join('-').replace(/[^\w.@-]+/g, '-')}.json`
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(
    `${outDir}/${outFile}`,
    JSON.stringify(
      {
        run_id: runId,
        today,
        model,
        effort,
        prompt: promptName,
        repeats,
        grading,
        pricing,
        by_tag: byTag,
        cases: results,
      },
      null,
      2,
    ) + '\n',
  )

  const allRuns = results.flatMap((entry) => entry.runs)

  console.log('\n\n  ' + 'grader'.padEnd(26) + 'pass')
  let totalPass = 0
  let totalGraded = 0

  for (const name of Object.keys(GRADERS)) {
    // null grades are not applicable to the case and stay out of the denominator.
    const graded = allRuns.map((run) => run.grades?.[name]).filter((grade) => grade != null)
    const passed = graded.filter(Boolean).length
    totalPass += passed
    totalGraded += graded.length
    console.log(`  ${name.padEnd(18)}${passed}/${graded.length}`.padEnd(28) + percent(passed, graded.length))
  }
  console.log('  ' + '-'.repeat(30))
  console.log(`  ${'overall'.padEnd(18)}${totalPass}/${totalGraded}`.padEnd(28) + percent(totalPass, totalGraded))

  // Worst first: the weakest tag is the one worth reading.
  const tags = Object.entries(byTag).sort(
    ([, a], [, b]) => a.passed / a.scored - b.passed / b.scored,
  )
  if (tags.length > 0) {
    console.log('\n  ' + 'tag'.padEnd(26) + 'case pass')
    for (const [tag, { passed, scored }] of tags) {
      console.log(`  ${tag.padEnd(18)}${passed}/${scored}`.padEnd(28) + percent(passed, scored))
    }
  }

  const failed = allRuns.filter((run) => run.status !== 'ok')
  const scored = allRuns.filter((run) => run.passed !== undefined)
  const passed = scored.filter((run) => run.passed).length
  const tokens = allRuns.reduce(
    (sum, run) => ({
      input: sum.input + run.usage.input,
      output: sum.output + run.usage.output,
      reasoning: sum.reasoning + (run.usage.reasoning ?? 0),
      cached: sum.cached + run.usage.cached,
      written: sum.written + run.usage.written,
      total: sum.total + run.usage.total,
    }),
    { input: 0, output: 0, reasoning: 0, cached: 0, written: 0, total: 0 },
  )

  console.log(
    `\n  runs ${allRuns.length}   ok ${allRuns.length - failed.length}   errors ${failed.length}   case pass ${passed}/${scored.length}`,
  )
  console.log(`  tokens  in ${tokens.input}  out ${tokens.output}  reasoning ${tokens.reasoning}  total ${tokens.total}`)
  console.log(`  cache   read ${tokens.cached}  written ${tokens.written}`)

  for (const entry of results) {
    for (const run of entry.runs) {
      if (run.status !== 'ok') console.log(`  ! ${entry.lang}/${entry.id} #${run.repeat} ${run.status}: ${run.error}`)
    }
  }
  console.log(`\n  → ${outDir}/${outFile}`)
}

function percent(passed: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((passed / total) * 100)}%`
}

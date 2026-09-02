import fs from 'node:fs'
import { readRun } from './dashboard/read.ts'
import { page } from './dashboard/render.ts'
import { build } from './dashboard/view.ts'
import { GRADERS, gradeAll, type Grade } from './grade.ts'
import { anthropic } from './providers/anthropic.ts'
import { gemini } from './providers/gemini.ts'
import { openai } from './providers/openai.ts'
import { errorMessage } from './providers/retry.ts'
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
  /** Calls in flight at once, within one model. */
  concurrency?: number
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

const concurrency = Number(args.concurrency ?? config.concurrency ?? 4)
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error(`concurrency must be a positive integer, got "${args.concurrency ?? config.concurrency}"`)
}

// --run re-enters an existing results directory instead of opening a new one:
// models that already wrote their file are skipped, and a model that died
// halfway resumes from its partial log. Without it the id is the start time, so
// a fresh run can never land on top of an earlier one.
const resumeId = args.run
if (resumeId !== undefined && !/^[\w.-]+$/.test(resumeId)) {
  throw new Error(`--run must be a plain directory name, got "${resumeId}"`)
}
const now = new Date()
const iso = now.toISOString()
const runId = resumeId ?? `${iso.slice(0, 10)}T${iso.slice(11, 16).replace(':', '')}Z`

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

// A comma-separated list runs several dataset files as one set, in the order given.
const files = args.file
  ? args.file.split(',').map((name) => `${name.trim()}.jsonl`)
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
  /** Calls the response cost. Written only when retries happened. */
  attempts?: number
  grades?: Record<string, Grade>
  passed?: boolean
  actual: unknown
  usage: TokenUsage
  latency_ms: number
}

/** A run as it sits in the partial log, under the key that identifies it. */
interface LoggedRun extends Run {
  key: string
}

const ADAPTERS: Record<string, Provider> = { openai, anthropic, gemini }

// --model runs one entry out of the config rather than overriding its id.
const entries = args.model ? config.models.filter((e) => e.model === args.model) : config.models
if (entries.length === 0) {
  throw new Error(`no model matches "${args.model}" in eval.config.json`)
}

console.log(`flight-search-eval  run ${runId}${resumeId ? ' (resuming)' : ''}`)
console.log(`prompt ${promptName}  repeats ${repeats}  pin ${today}  concurrency ${concurrency}`)
console.log(
  `grading ${grading.embedding_model}  similarity >= ${grading.similarity_threshold}`,
)
console.log(
  `${cases.length} cases × ${repeats} repeats × ${entries.length} model${entries.length === 1 ? '' : 's'} = ${cases.length * repeats * entries.length} calls`,
)

// Sequential: one model at a time already keeps `concurrency` calls in flight,
// and a rate limit shared between two models is one neither of them can plan for.
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

  const outDir = `results/${runId}`
  // One file per model and effort, so a directory holds a whole comparison and a
  // re-run of one model leaves the others alone. Slashes appear in some model ids.
  const base = [model, effort].filter(Boolean).join('-').replace(/[^\w.@-]+/g, '-')
  const outFile = `${base}.json`
  const partialPath = `${outDir}/${base}.partial.jsonl`
  fs.mkdirSync(outDir, { recursive: true })

  // A model that already wrote its result file is finished; --run is for the rest.
  if (fs.existsSync(`${outDir}/${outFile}`)) {
    console.log(`  ${outFile} already written — skipping`)
    return
  }

  // Fixed key order: this is compared against the partial log's header verbatim.
  const meta = {
    prompt: promptName,
    today,
    repeats,
    provider: entry.provider,
    model,
    effort,
    max_tokens: entry.max_tokens,
    params: entry.params,
    grading,
  }
  const done = readPartial(partialPath, meta)

  const callCase = async (testCase: Case, repeat: number): Promise<Run> => {
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

    let grades: Record<string, Grade> | undefined
    let gradeError: string | undefined
    if (result) {
      try {
        grades = await gradeAll(result, testCase.expect, { today, grading })
      } catch (error) {
        // The call is paid for and about to be logged. An embeddings API that
        // cannot be reached leaves this run unscored; it does not end the eval.
        gradeError = `grading: ${errorMessage(error)}`
      }
    }

    const error = response.error ?? gradeError
    return {
      repeat,
      status: response.status,
      ...(error ? { error } : {}),
      ...(response.attempts > 1 ? { attempts: response.attempts } : {}),
      ...(grades
        ? { grades, passed: Object.values(grades).every((grade) => grade !== false) }
        : {}),
      actual: response.output,
      usage: response.usage,
      latency_ms: response.latency_ms,
    }
  }

  // One task per call still owed, and a slot per case to put the answer back in,
  // so the result file lists cases in dataset order however they finish.
  const slots: Run[][] = cases.map(() => [])
  const tasks: { index: number; testCase: Case; repeat: number }[] = []
  for (const [index, testCase] of cases.entries()) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const logged = done.get(runKey(testCase, repeat))
      if (logged) slots[index]![repeat - 1] = logged
      else tasks.push({ index, testCase, repeat })
    }
  }

  const reused = cases.length * repeats - tasks.length
  if (reused > 0) {
    console.log(`  ${reused} runs read back from ${base}.partial.jsonl, ${tasks.length} still to call`)
  }
  if (tasks.length > 0 && !fs.existsSync(partialPath)) {
    fs.writeFileSync(partialPath, JSON.stringify(meta) + '\n')
  }

  // Workers share one cursor, so a slow case holds up only itself. Each finished
  // run is appended before its worker takes the next task: a crash costs the
  // calls in flight, not the ones already paid for.
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (cursor < tasks.length) {
        const { index, testCase, repeat } = tasks[cursor++]!
        const run = await callCase(testCase, repeat)
        slots[index]![repeat - 1] = run
        const logged: LoggedRun = { key: runKey(testCase, repeat), ...run }
        fs.appendFileSync(partialPath, JSON.stringify(logged) + '\n')
        process.stdout.write(run.status === 'ok' ? '.' : 'x')
      }
    }),
  )

  const results = cases.map((testCase, index) => ({
    ...testCase,
    tags: testCase.tags ?? [],
    runs: slots[index]!,
  }))

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
  // The partial log stays: it is the only copy of any run left out of the file
  // by a narrower --file or --limit, and a finished model is skipped by name.

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
  const retried = allRuns.filter((run) => run.attempts !== undefined).length
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
  if (retried > 0) console.log(`  retried ${retried} of ${allRuns.length} calls`)

  for (const entry of results) {
    for (const run of entry.runs) {
      if (run.status !== 'ok') console.log(`  ! ${entry.lang}/${entry.id} #${run.repeat} ${run.status}: ${run.error}`)
      // An ok call with no grades answered fine and could not be scored.
      else if (!run.grades) console.log(`  ? ${entry.lang}/${entry.id} #${run.repeat} unscored: ${run.error}`)
    }
  }
  console.log(`\n  → ${outDir}/${outFile}`)
}

/** Identifies one call within a model's log. Unique: no lang repeats an id. */
function runKey(testCase: Case, repeat: number): string {
  return `${testCase.lang}/${testCase.id}#${repeat}`
}

/**
 * Runs an earlier process already paid for. The header line records what they
 * were produced under, so a log left over from another prompt, pin or model
 * entry is refused rather than mixed into this run's results.
 */
function readPartial(path: string, meta: unknown): Map<string, Run> {
  const done = new Map<string, Run>()
  if (!fs.existsSync(path)) return done

  const lines = fs.readFileSync(path, 'utf8').split('\n').filter((line) => line.trim())
  const header = lines.shift()
  if (header === undefined) return done
  if (header !== JSON.stringify(meta)) {
    throw new Error(
      `${path} was written under different settings — delete it or start a fresh run\n` +
        `    log:  ${header}\n` +
        `    this: ${JSON.stringify(meta)}`,
    )
  }

  for (const line of lines) {
    let logged: LoggedRun
    try {
      logged = JSON.parse(line) as LoggedRun
    } catch {
      // The crash being recovered from can have cut its last append in half.
      continue
    }
    const { key, ...run } = logged
    done.set(key, run)
  }
  return done
}

function percent(passed: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((passed / total) * 100)}%`
}

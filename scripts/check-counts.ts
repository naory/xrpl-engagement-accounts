// Compare documented counts with the repo.
//
// Each count is stated once, in a Markdown HTML marker:
//   <!-- count:NAME -->N<!-- /count -->
// The script fails if a marker is missing, duplicated, unknown, or wrong.
//
// Counts:
//   tests                 Default Vitest suite (`vitest run` / `npm test` / vitest.config.ts).
//                         This is the suite CI's Test step runs. It does not include
//                         vitest.x402.config.ts, vitest.mpp.config.ts, or tests the default
//                         config excludes.
//   tests-sweep           Only when vitest.sweep.config.ts exists. Those tests are not part of `tests`.
//   vectors-total         cases in vectors/{policy,templates,statements}.json
//   vectors-policy        cases in vectors/policy.json
//   vectors-hotel2        policy cases whose name starts with "hotel2."
//   vectors-template      cases in vectors/templates.json
//   vectors-statement     cases in vectors/statements.json
//
// The test total is not produced by running the suite a second time.
// - When VITEST_JSON is set, `tests` is `numTotalTests` from that Vitest JSON reporter
//   file. CI's Test step writes it while the suite runs.
// - Otherwise `tests` comes from `vitest list --no-staticParse`, which loads the files
//   and does not execute tests. Static parsing is off because several suites register
//   tests inside loops; a static parse under-counts them (404 vs 603 on this tree).
//   `vitest list` omits tests skipped at collection time. The JSON reporter's
//   numTotalTests includes those. This repo has no skipped or todo tests, so the two
//   numbers match. In CI, VITEST_JSON is required so the documented total is the suite
//   the Test step actually collected.
// - `tests-sweep` always uses `vitest list` against the sweep config. Listing collects
//   the cases and does not run them.
// - A file named `*.sweep.test.ts` is never part of `tests`. When the sweep config
//   exists, every file it collects must be one of those.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SWEEP_CONFIG = 'vitest.sweep.config.ts'

const MARKER = /<!--\s*count:([a-z0-9-]+)\s*-->(\d+)<!--\s*\/count\s*-->/g

interface Hit { file: string; line: number; name: string; value: number }

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'lychee') continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) markdownFiles(p, out)
    else if (ent.name.endsWith('.md')) out.push(p)
  }
  return out
}

function markers(): Hit[] {
  const hits: Hit[] = []
  for (const file of markdownFiles(root)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      MARKER.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = MARKER.exec(lines[i])) !== null) {
        const digits = m[2]
        const value = Number(digits)
        hits.push({ file: path.relative(root, file), line: i + 1, name: m[1], value: String(value) === digits ? value : Number.NaN })
      }
    }
  }
  return hits
}

function readJson(rel: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) as unknown
}

function casesOf(rel: string): Array<{ name?: unknown }> {
  const raw = readJson(rel)
  if (!raw || typeof raw !== 'object' || !('cases' in raw) || !Array.isArray((raw as { cases: unknown }).cases)) {
    throw new Error(`${rel} has no cases array`)
  }
  return (raw as { cases: Array<{ name?: unknown }> }).cases
}

interface Collected { count: number; files: string[] }

function reportTotal(file: string): Collected {
  const abs = path.resolve(root, file)
  const raw: unknown = JSON.parse(fs.readFileSync(abs, 'utf8'))
  if (!raw || typeof raw !== 'object' || !('numTotalTests' in raw) || typeof (raw as { numTotalTests: unknown }).numTotalTests !== 'number') {
    throw new Error(`${file} is not a Vitest JSON report (no numeric numTotalTests)`)
  }
  const report = raw as { numTotalTests: number; testResults?: unknown }
  if (!Array.isArray(report.testResults)) throw new Error(`${file} has no testResults array`)
  const files: string[] = []
  let asserted = 0
  for (const row of report.testResults) {
    if (!row || typeof row !== 'object' || typeof (row as { name?: unknown }).name !== 'string' || !Array.isArray((row as { assertionResults?: unknown }).assertionResults)) {
      throw new Error(`${file} has a testResults row without name and assertionResults`)
    }
    files.push((row as { name: string }).name)
    asserted += (row as { assertionResults: unknown[] }).assertionResults.length
  }
  if (asserted !== report.numTotalTests) {
    throw new Error(`${file} numTotalTests is ${report.numTotalTests} but assertionResults sum to ${asserted}`)
  }
  return { count: report.numTotalTests, files }
}

/** Collect tests without executing them. `config` is a Vitest config path, relative to the repo root. */
function listTests(config?: string): Collected {
  const out = path.join(os.tmpdir(), `eng-vitest-list-${process.pid}-${config ? 'sweep' : 'default'}.json`)
  const bin = path.join(root, 'node_modules/vitest/vitest.mjs')
  const args = [bin, 'list', '--no-staticParse', `--json=${out}`]
  if (config) args.push('-c', config)
  try {
    execFileSync(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const raw: unknown = JSON.parse(fs.readFileSync(out, 'utf8'))
    if (!Array.isArray(raw)) throw new Error(`vitest list wrote a non-array to ${out}`)
    const files: string[] = []
    for (const row of raw) {
      if (!row || typeof row !== 'object' || typeof (row as { file?: unknown }).file !== 'string') {
        throw new Error('vitest list JSON has an item without a file')
      }
      files.push((row as { file: string }).file)
    }
    return { count: files.length, files }
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string }
    const stderr = err.stderr?.toString().trim()
    throw new Error(`vitest list failed${config ? ` (-c ${config})` : ''}${stderr ? `: ${stderr}` : `: ${err.message ?? e}`}`)
  } finally {
    fs.rmSync(out, { force: true })
  }
}

/** `*.sweep.test.ts` belongs to tests-sweep, never to the default suite. */
function partitionProblems(defaultFiles: string[], sweepFiles?: string[]): string[] {
  const problems: string[] = []
  const leaked = defaultFiles.filter((f) => f.endsWith('.sweep.test.ts'))
  if (leaked.length) problems.push(`default suite includes ${leaked.length} *.sweep.test.ts file(s); those are tests-sweep, not tests`)
  if (sweepFiles) {
    const other = sweepFiles.filter((f) => !f.endsWith('.sweep.test.ts'))
    if (other.length) problems.push(`sweep config collected ${other.length} file(s) that are not *.sweep.test.ts`)
  }
  return problems
}

function main(): void {
  const problems: string[] = []
  const sweep = fs.existsSync(path.join(root, SWEEP_CONFIG))
  const expected = new Map<string, { value: number; how: string }>()

  const report = process.env.VITEST_JSON
  const ci = process.env.CI === 'true' || process.env.CI === '1'
  if (ci && !report) {
    problems.push('CI is set but VITEST_JSON is not. Point it at the JSON reporter file from the Test step so the suite is not collected again.')
  }
  let testsHow = ''
  let defaultFiles: string[] | undefined
  if (report) {
    const collected = reportTotal(report)
    testsHow = `numTotalTests in ${report} (default suite JSON reporter)`
    expected.set('tests', { value: collected.count, how: testsHow })
    defaultFiles = collected.files
  } else if (!ci) {
    const collected = listTests()
    testsHow = 'vitest list --no-staticParse (default suite, tests not executed)'
    expected.set('tests', { value: collected.count, how: testsHow })
    defaultFiles = collected.files
  }

  let sweepFiles: string[] | undefined
  if (sweep) {
    const collected = listTests(SWEEP_CONFIG)
    sweepFiles = collected.files
    expected.set('tests-sweep', { value: collected.count, how: `vitest list --no-staticParse -c ${SWEEP_CONFIG} (not executed)` })
  }
  if (defaultFiles) problems.push(...partitionProblems(defaultFiles, sweepFiles))

  const policy = casesOf('vectors/policy.json')
  const templates = casesOf('vectors/templates.json').length
  const statements = casesOf('vectors/statements.json').length
  const hotel2 = policy.filter((c) => typeof c.name === 'string' && c.name.startsWith('hotel2.')).length
  expected.set('vectors-policy', { value: policy.length, how: 'vectors/policy.json cases' })
  expected.set('vectors-hotel2', { value: hotel2, how: 'policy cases named hotel2.*' })
  expected.set('vectors-template', { value: templates, how: 'vectors/templates.json cases' })
  expected.set('vectors-statement', { value: statements, how: 'vectors/statements.json cases' })
  expected.set('vectors-total', { value: policy.length + templates + statements, how: 'policy + template + statement cases' })

  const hits = markers()
  const byName = new Map<string, Hit[]>()
  for (const hit of hits) {
    const list = byName.get(hit.name) ?? []
    list.push(hit)
    byName.set(hit.name, list)
    if (Number.isNaN(hit.value)) problems.push(`${hit.file}:${hit.line}: count:${hit.name} is not a canonical integer`)
  }

  for (const [name, list] of byName) {
    if (!expected.has(name)) {
      if (name === 'tests' && ci && !report) continue
      const where = list.map((h) => `${h.file}:${h.line}`).join(', ')
      problems.push(`unknown count marker ${name} (${where})${name === 'tests-sweep' && !sweep ? `; ${SWEEP_CONFIG} is not in the repo` : ''}`)
    } else if (list.length > 1) {
      problems.push(`count:${name} appears ${list.length} times (${list.map((h) => `${h.file}:${h.line}`).join(', ')}); state it once`)
    }
  }

  for (const [name, exp] of expected) {
    const list = byName.get(name) ?? []
    if (list.length === 0) {
      problems.push(`missing <!-- count:${name} -->${exp.value}<!-- /count --> (${exp.how})`)
      continue
    }
    const hit = list[0]
    if (list.length === 1 && hit && !Number.isNaN(hit.value) && hit.value !== exp.value) {
      problems.push(`${hit.file}:${hit.line}: count:${name} documents ${hit.value}, actual is ${exp.value} (${exp.how})`)
    }
  }

  if (problems.length) {
    console.error('check-counts: failed')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }

  console.log('check-counts: ok')
  for (const [name, exp] of expected) console.log(`  ${name} ${exp.value} (${exp.how})`)
}

main()

// Write the generated block in docs/costs.md.
//
// Template rows are the `tickets needed` / `reserve` lines from `npm run validate-templates`.
// hotel@2 stay rows are hotelTickets(nights) for the Ticket count and validateTemplate for the
// reserve, on a copy whose stay-variant cap equals the variants that call booked.
// Fees are buildOpenBatch / buildCloseBatch / batchFee at the validator's reserve defaults and
// the snapshot's base-fee fallback. The script does not invent those numbers.
//
//   npm run costs            rewrite the block
//   npm run costs -- --check fail if the committed block would change
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import xrpl from 'xrpl'
import { validateTemplate, type Template } from '@eng/core'
import { batchFee, buildCloseBatch, buildOpenBatch, type Fees } from '@eng/ledger'
import { ACCOUNT_DELETE_MIN_AGE } from '@eng/policy'
import { HotelFlow, hotelTickets } from '../packages/cosigner/src/hotel/flow.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOC = 'docs/costs.md'
const BEGIN = '<!-- costs:begin -->'
const END = '<!-- costs:end -->'

const CITE = /`([A-Za-z_][A-Za-z0-9_]*)`\s*\(`([^`\s]+):(\d+)(?:-(\d+))?`\)/g
const PATH_OK = /^(?:\.env\.example|(?:packages|templates|policies|scripts|docs)\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+\.(?:ts|json|md))$/

interface CliRow { ok: boolean; templateId: string; file: string; tickets: number; reservePrinted: string }
interface StayRow { nights: number; tickets: number; reserve: bigint; booked: number; precreate: bigint }
interface FeeRow { label: string; signatures: string; headroom: string; inners: number; drops: bigint }

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function mustMatch(rel: string, re: RegExp, what: string): string {
  const m = read(rel).match(re)
  if (!m?.[1]) throw new Error(`${rel} has no ${what}`)
  return m[1]
}

function dropsLiteral(raw: string): bigint {
  return BigInt(raw.replaceAll('_', ''))
}

function formatXrp(drops: bigint): string {
  const neg = drops < 0n
  const abs = neg ? -drops : drops
  const whole = abs / 1_000_000n
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}.${frac === '' ? '0' : frac}`
}

function nightLabel(n: number): string {
  return n === 1 ? '1 night' : `${n} nights`
}

function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  return [head, sep, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

function loadTemplate(rel: string): Template {
  return JSON.parse(read(rel)) as Template
}

function templateFiles(): string[] {
  return fs.readdirSync(path.join(root, 'templates')).filter((f) => f.endsWith('.json')).sort().map((f) => `templates/${f}`)
}

/** The same command CI runs. Rows are parsed from its stdout. */
function validateTemplatesOutput(): CliRow[] {
  let stdout = ''
  try {
    stdout = execFileSync('npm', ['run', 'validate-templates'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    throw new Error(`npm run validate-templates failed (${err.status ?? '?'})\n${err.stdout ?? ''}\n${err.stderr ?? ''}`)
  }
  const rows: CliRow[] = []
  let cur: { ok: boolean; templateId: string; file: string } | null = null
  for (const line of stdout.split('\n')) {
    const head = line.match(/^(✅|❌) (\S+)\s+\(([^)]+)\)/)
    if (head) {
      cur = { ok: head[1] === '✅', templateId: head[2], file: head[3] }
      continue
    }
    const tickets = line.match(/tickets needed: (\d+), reserve: ([0-9.]+) XRP/)
    if (!tickets) continue
    if (!cur) throw new Error(`validate-templates printed a tickets line with no template header: ${line}`)
    rows.push({ ...cur, tickets: Number(tickets[1]), reservePrinted: tickets[2] })
    cur = null
  }
  if (!rows.length) throw new Error('validate-templates printed no tickets lines')
  const files = templateFiles()
  if (rows.length !== files.length) throw new Error(`validate-templates reported ${rows.length} templates, templates/ has ${files.length}`)
  for (const row of rows) {
    if (!row.ok) throw new Error(`validate-templates failed ${row.templateId} (${row.file})`)
    if (!files.includes(row.file)) throw new Error(`validate-templates reported unknown file ${row.file}`)
  }
  return rows
}

function referenceFees(): { fees: Fees; funding: bigint; headroom: bigint } {
  const funding = dropsLiteral(mustMatch('packages/core/src/cli.ts', /preCreateFundingDrops:\s*([0-9_]+)n/, 'preCreateFundingDrops'))
  const reserveBase = dropsLiteral(mustMatch('packages/core/src/template.ts', /reserveBaseDrops \?\? ([0-9_]+)n/, 'reserveBaseDrops default'))
  const inc = dropsLiteral(mustMatch('packages/core/src/template.ts', /reserveIncDrops \?\? ([0-9_]+)n/, 'reserveIncDrops default'))
  const headroom = dropsLiteral(mustMatch('packages/core/src/template.ts', /feeHeadroomDrops \?\? ([0-9_]+)n/, 'feeHeadroomDrops default'))
  const base = Number(mustMatch('packages/cosigner/src/snapshot.ts', /fee\.BaseFee \? BigInt\('0x' \+ String\(fee\.BaseFee\)\) : (\d+)/, 'base fee fallback'))
  const fees: Fees = { base, reserveBase: Number(reserveBase), inc: Number(inc) }
  return { fees, funding, headroom }
}

function confirmCli(rows: CliRow[], funding: bigint): void {
  for (const row of rows) {
    const r = validateTemplate(loadTemplate(row.file), { preCreateFundingDrops: funding })
    const printed = String(Number(r.reserveDrops) / 1e6)
    if (!r.ok) throw new Error(`${row.file} fails validateTemplate under the CLI funding: ${r.errors.map((e) => `${e.id} ${e.message}`).join('; ')}`)
    if (r.ticketsNeeded !== row.tickets || printed !== row.reservePrinted) {
      throw new Error(`${row.file}: validate-templates says ${row.tickets} Tickets / ${row.reservePrinted} XRP, validateTemplate says ${r.ticketsNeeded} / ${printed}`)
    }
  }
}

function staysFor(hotel: Template, funding: bigint, fees: Fees): StayRow[] {
  const outcome = hotel.outcomes['default.chargebackStay']
  const max = outcome?.variants?.max
  if (max == null) throw new Error(`${hotel.templateId} has no default.chargebackStay variants.max`)
  const rows: StayRow[] = []
  // The sheet lists 1 night through the cap (variants.max + 1). A longer stay is described in the prose.
  for (let nights = 1; nights <= max + 1; nights++) {
    const plan = hotelTickets(nights)
    const booked = Object.keys(plan.slices).filter((k) => k.startsWith('default.chargebackStay#')).length
    const copy = structuredClone(hotel)
    const stayOutcome = copy.outcomes['default.chargebackStay']
    if (!stayOutcome) throw new Error('cloned hotel template lost default.chargebackStay')
    stayOutcome.variants = { perNight: true, max: booked }
    const r = validateTemplate(copy, { preCreateFundingDrops: funding })
    if (!r.ok) throw new Error(`${hotel.templateId} at ${nights} nights failed validation: ${r.errors.map((e) => `${e.id} ${e.message}`).join('; ')}`)
    if (r.ticketsNeeded !== plan.count) {
      throw new Error(`hotelTickets(${nights}) counts ${plan.count} Tickets but validateTemplate counts ${r.ticketsNeeded}`)
    }
    const precreate = BigInt(HotelFlow.precreateDrops(fees, nights))
    rows.push({ nights, tickets: plan.count, reserve: r.reserveDrops, booked, precreate })
  }
  // The prose says a stay past the cap falls back to the 1-night Ticket set. Fail here if that stops being true.
  const past = hotelTickets(max + 2)
  const first = hotelTickets(1)
  const pastVariants = Object.keys(past.slices).filter((k) => k.startsWith('default.chargebackStay#')).length
  if (past.count !== first.count || pastVariants !== 0) {
    throw new Error(`hotelTickets(${max + 2}) counts ${past.count} Tickets and ${pastVariants} stay variants; hotelTickets(1) counts ${first.count}. Update the cap prose in docs/costs.md if a stay past the cap no longer falls back to the 1-night set.`)
  }
  return rows
}

function txFee(tx: { Fee?: unknown; RawTransactions?: unknown }): { drops: bigint; inners: number } {
  if (!Array.isArray(tx.RawTransactions)) throw new Error('built transaction has no RawTransactions')
  return { drops: BigInt(String(tx.Fee)), inners: tx.RawTransactions.length }
}

function openFee(fees: Fees, ticketCount: number): { drops: bigint; inners: number } {
  const { tx } = buildOpenBatch({
    eng: 'rENG', funder: 'rFunder', currency: 'RLUSD', issuer: 'rIssuer', amount: '1',
    signerEntries: [['rSigner', 1]], quorum: 1, seq: 10, funderSeq: 10, ticketCount, memos: [], fees,
  })
  return txFee(tx)
}

function closeFee(fees: Fees, payouts: number, signatures: number): { drops: bigint; inners: number } {
  const tx = buildCloseBatch({
    eng: 'rENG', currency: 'RLUSD', issuer: 'rIssuer',
    payouts: Array.from({ length: payouts }, (_, i) => ({ to: `rPayee${i}`, value: '1' })),
    deleteTo: 'rService', seq: 10, lastLedgerSequence: 40, memos: [], fees, signatures,
  })
  return txFee(tx)
}

function closeRows(fees: Fees): FeeRow[] {
  const rows: FeeRow[] = []
  const seen = new Set<string>()
  for (const file of templateFiles()) {
    const t = loadTemplate(file)
    for (const [blueprint, bp] of Object.entries(t.blueprints)) {
      if (!bp.closes) continue
      const payouts = bp.steps.filter((s) => s.startsWith('pay.')).length
      const sigs = new Set<number>()
      for (const outcome of Object.values(t.outcomes)) {
        if (outcome.blueprint !== blueprint) continue
        for (const set of outcome.signers ?? []) sigs.add(set.length)
      }
      if (!sigs.size) throw new Error(`${t.templateId} ${blueprint} closes but no outcome signs it`)
      for (const signatures of [...sigs].sort((a, b) => a - b)) {
        const key = `${t.templateId}|${blueprint}|${signatures}|${payouts}`
        if (seen.has(key)) continue
        seen.add(key)
        const fee = closeFee(fees, payouts, signatures)
        rows.push({
          label: `${t.templateId} ${blueprint}, ${payouts} pay ${payouts === 1 ? 'step' : 'steps'}`,
          signatures: String(signatures),
          headroom: '1.5',
          inners: fee.inners,
          drops: fee.drops,
        })
      }
    }
  }
  return rows
}

/** batchFee adds one reserve increment per AccountDelete and drops that inner from the base-fee units. */
function accountDeleteSpecial(fees: Fees): bigint {
  const one = (type: string) => BigInt(batchFee({
    base: fees.base, inc: fees.inc, signatures: 1, headroom: 1,
    innerTxs: [{ RawTransaction: { TransactionType: type } }],
  }))
  const delta = one('AccountDelete') - one('Payment')
  const expected = BigInt(fees.inc) - BigInt(Math.ceil(fees.base))
  if (delta !== expected) {
    throw new Error(`batchFee AccountDelete delta is ${delta} drops; reading it as one reserve increment expected ${expected}. The sheet will not label ${fees.inc} drops as that fee.`)
  }
  return BigInt(fees.inc)
}

function ages(): number {
  const flow = Number(mustMatch('packages/cosigner/src/hotel/flow.ts', /const ACCOUNT_DELETE_MIN_AGE = (\d+)/, 'ACCOUNT_DELETE_MIN_AGE'))
  const pool = Number(mustMatch('packages/cosigner/src/pool-cli.ts', /agingLedgers:\s*(\d+)/, 'agingLedgers'))
  if (ACCOUNT_DELETE_MIN_AGE !== flow || ACCOUNT_DELETE_MIN_AGE !== pool) {
    throw new Error(`AccountDelete age disagrees: policy ${ACCOUNT_DELETE_MIN_AGE}, hotel flow ${flow}, pool CLI ${pool}`)
  }
  return ACCOUNT_DELETE_MIN_AGE
}

function procurementCreateDrops(): bigint {
  const whole = mustMatch('packages/cosigner/demo/b1-testnet.ts', /Destination: eng\.address, Amount: xrpl\.xrpToDrops\((\d+)\)/, 'pre-create xrpToDrops')
  return BigInt(xrpl.xrpToDrops(Number(whole)))
}

function poolCreateDrops(): bigint {
  return BigInt(mustMatch('packages/cosigner/src/pool-cli.ts', /createAmountDrops: env\('ENG_CREATE_DROPS', '(\d+)'\)/, 'ENG_CREATE_DROPS default'))
}

function render(cli: CliRow[], hotelId: string, stay: StayRow[], fees: Fees, funding: bigint, headroom: bigint, special: bigint, age: number): string {
  const byFile = new Map(cli.map((r) => [r.file, r]))
  const hotelFile = templateFiles().find((f) => loadTemplate(f).templateId === hotelId)
  if (!hotelFile) throw new Error(`no template file for ${hotelId}`)
  const hotel = loadTemplate(hotelFile)
  const max = hotel.outcomes['default.chargebackStay']?.variants?.max
  if (max == null) throw new Error('hotel template lost variants.max')
  const cap = stay.find((s) => s.nights === max + 1)
  const one = stay.find((s) => s.nights === 1)
  const cliHotel = cli.find((r) => r.templateId === hotelId)
  if (!cap || !one || !cliHotel) throw new Error('missing cap, 1-night, or validate-templates hotel row')
  if (cliHotel.tickets !== cap.tickets || cliHotel.reservePrinted !== String(Number(cap.reserve) / 1e6)) {
    throw new Error(`${hotelId} at ${cap.nights} nights is ${cap.tickets} Tickets / ${formatXrp(cap.reserve)} XRP, validate-templates printed ${cliHotel.tickets} / ${cliHotel.reservePrinted}`)
  }

  const owners = cli.filter((r) => loadTemplate(r.file).class === 'owner-wallet')
  const checkpoints: string[][] = [
    ...owners.map((r) => [r.templateId, String(r.tickets), `${formatXrp(validateTemplate(loadTemplate(r.file), { preCreateFundingDrops: funding }).reserveDrops)} XRP`]),
    ...[1, 3, cap.nights].map((n) => {
      const row = stay.find((s) => s.nights === n)
      if (!row) throw new Error(`no stay row for ${n} nights`)
      return [`${hotelId}, ${nightLabel(n)}`, String(row.tickets), `${formatXrp(row.reserve)} XRP`]
    }),
  ]

  const templateTable = mdTable(
    ['Template', 'File', 'Tickets', 'Reserve'],
    cli.map((r) => [r.templateId, `\`${r.file}\``, String(r.tickets), `${formatXrp(validateTemplate(loadTemplate(r.file), { preCreateFundingDrops: funding }).reserveDrops)} XRP`]),
  )
  const stayTable = mdTable(
    ['Stay', 'Stay variants booked', 'Tickets', 'Reserve', 'precreateDrops'],
    stay.map((s) => [nightLabel(s.nights), String(s.booked), String(s.tickets), `${formatXrp(s.reserve)} XRP`, `${formatXrp(s.precreate)} XRP`]),
  )

  const openRows: FeeRow[] = [0, 1, cap.tickets].map((n) => {
    const fee = openFee(fees, n)
    return { label: `Open, ticketCount ${n}`, signatures: '1', headroom: '2', inners: fee.inners, drops: fee.drops }
  })
  const closes = closeRows(fees)
  const feeTable = mdTable(
    ['Transaction', 'Signatures', 'Headroom', 'Inners', 'Fee (drops)', 'Fee (XRP)'],
    [...openRows, ...closes].map((r) => [r.label, r.signatures, r.headroom, String(r.inners), String(r.drops), formatXrp(r.drops)]),
  )
  const marginal = closeFee(fees, 3, 3).drops - closeFee(fees, 2, 3).drops
  const extras = new Set(stay.map((s) => s.precreate - s.reserve))
  const extraText = extras.size === 1
    ? `For every stay above, precreateDrops is the reserve plus ${formatXrp([...extras][0])} XRP (${[...extras][0]} drops).`
    : `precreateDrops minus reserve is not the same on every stay: ${[...extras].join(', ')} drops.`

  const three = stay.find((s) => s.nights === 3)
  if (!three) throw new Error('no 3-night stay row')
  const pool = poolCreateDrops()
  const demo = procurementCreateDrops()
  const fundingTable = mdTable(
    ['Funding', 'Drops', 'XRP'],
    [
      ['validate-templates preCreateFundingDrops', String(funding), formatXrp(funding)],
      ['feeHeadroomDrops default', String(headroom), formatXrp(headroom)],
      [`${hotelId} precreateDrops, ${nightLabel(1)}`, String(one.precreate), formatXrp(one.precreate)],
      [`${hotelId} precreateDrops, ${nightLabel(3)}`, String(three.precreate), formatXrp(three.precreate)],
      [`${hotelId} precreateDrops, ${nightLabel(cap.nights)}`, String(cap.precreate), formatXrp(cap.precreate)],
      ['pool CLI ENG_CREATE_DROPS default', String(pool), formatXrp(pool)],
      ['procurement demo pre-create payment', String(demo), formatXrp(demo)],
    ],
  )

  const lines = [
    'Generated by `npm run costs`. Template figures are the `tickets needed` / `reserve` lines of `npm run validate-templates`. Stay figures are `hotelTickets` and `validateTemplate`. Fee figures are `buildOpenBatch`, `buildCloseBatch`, and `batchFee`.',
    '',
    '### Checkpoints',
    '',
    mdTable(['Deal', 'Tickets', 'Reserve'], checkpoints),
    '',
    'Owner-wallet rows are every `owner-wallet` template in the validate-templates output. The hotel rows are 1 night, 3 nights, and the stay that books `variants.max` stay variants.',
    '',
    '### Every template, as validate-templates prints it',
    '',
    templateTable,
    '',
    `### ${hotelId} by stay length`,
    '',
    stayTable,
    '',
    `A stay of ${nightLabel(cap.nights)} books ${cap.tickets} Tickets and ${formatXrp(cap.reserve)} XRP, the same line validate-templates prints for \`${hotelId}\` (${byFile.get(cliHotel.file)?.tickets} Tickets, ${byFile.get(cliHotel.file)?.reservePrinted} XRP).`,
    '',
    '### Open and close fees',
    '',
    `Schedule: base fee ${fees.base} drops (snapshot fallback when the ledger fee object has neither BaseFeeDrops nor BaseFee), reserve base ${fees.reserveBase} drops, reserve increment ${fees.inc} drops (${formatXrp(BigInt(fees.inc))} XRP). Open headroom is 2. Close headroom is the batchFee default 1.5. Close signature counts are the signer-set lengths on the outcome that uses the blueprint.`,
    '',
    feeTable,
    '',
    `Open fee is ${openRows[0]?.drops} drops at ticketCount 0, ${openRows[1]?.drops} drops at ticketCount 1, and ${openRows[2]?.drops} drops at ticketCount ${cap.tickets}.`,
    '',
    `Each additional pay step changes a 3-signature close by ${marginal} drops at this schedule.`,
    '',
    `AccountDelete special fee: ${special} drops (${formatXrp(special)} XRP) per inner AccountDelete. Close rows above already include it. batchFee adds the reserve increment and leaves that inner out of the base-fee unit count.`,
    '',
    '### Ledger age',
    '',
    `AccountDelete minimum age: ${age} ledgers. \`ACCOUNT_DELETE_MIN_AGE\` in policy, the hotel flow's constant of the same name, and the pool CLI \`agingLedgers\` are all ${age}.`,
    '',
    '### Pre-create funding',
    '',
    fundingTable,
    '',
    extraText,
    '',
    `The template check allows preCreateFundingDrops of ${formatXrp(funding)} XRP. A stay of ${nightLabel(cap.nights)} reserves ${formatXrp(cap.reserve)} XRP. Reserve plus the default fee headroom of ${formatXrp(headroom)} XRP is ${formatXrp(cap.reserve + headroom)} XRP.`,
    '',
  ]
  return lines.join('\n')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function proseProblems(doc: string): string[] {
  const start = doc.indexOf(BEGIN)
  const end = doc.indexOf(END)
  if (start < 0 || end < start) return [`${DOC} is missing ${BEGIN} … ${END}`]
  const prose = `${doc.slice(0, start)}\n${doc.slice(end + END.length)}`
  const problems: string[] = []
  const chunks = prose.split(/\n{2,}/)
  for (const chunk of chunks) {
    const text = chunk.trim()
    if (!text) continue
    const lines = text.split('\n')
    if (lines.every((l) => /^#{1,6} /.test(l) || /^<!--/.test(l) || l.trim() === '')) continue
    const cites = [...text.matchAll(CITE)]
    if (!cites.length) {
      problems.push(`prose has no file:line citation: ${text.split('\n')[0]}`)
      continue
    }
    for (const cite of cites) {
      const symbol = cite[1] ?? ''
      const file = cite[2] ?? ''
      const lineNo = Number(cite[3])
      const endNo = cite[4] ? Number(cite[4]) : lineNo
      if (!PATH_OK.test(file)) {
        problems.push(`citation path not allowed: ${file} (${symbol})`)
        continue
      }
      const abs = path.join(root, file)
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        problems.push(`cited file missing: ${file} (${symbol})`)
        continue
      }
      const sourceLines = fs.readFileSync(abs, 'utf8').split('\n')
      if (endNo < lineNo || endNo > sourceLines.length) {
        problems.push(`${file}:${lineNo}-${endNo} is not a line range of ${symbol}`)
        continue
      }
      const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`)
      const hit = sourceLines.slice(lineNo - 1, endNo).some((line) => re.test(line))
      if (!hit) problems.push(`${file}:${lineNo}${endNo === lineNo ? '' : `-${endNo}`} does not contain ${symbol}`)
    }
  }
  return problems
}

function splice(doc: string, generated: string): string {
  const start = doc.indexOf(BEGIN)
  const end = doc.indexOf(END)
  if (start < 0 || end < start) throw new Error(`${DOC} must contain ${BEGIN} before ${END}`)
  if (doc.indexOf(BEGIN, start + BEGIN.length) !== -1) throw new Error(`${DOC} has two ${BEGIN} markers`)
  if (doc.indexOf(END, end + END.length) !== -1) throw new Error(`${DOC} has two ${END} markers`)
  const body = generated.endsWith('\n') ? generated : `${generated}\n`
  const next = `${doc.slice(0, start + BEGIN.length)}\n${body}${doc.slice(end)}`
  return next.endsWith('\n') ? next : `${next}\n`
}

function unified(current: string, next: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'costs-'))
  const a = path.join(dir, 'current.md')
  const b = path.join(dir, 'next.md')
  fs.writeFileSync(a, current)
  fs.writeFileSync(b, next)
  try {
    execFileSync('diff', ['-u', a, b], { encoding: 'utf8' })
    return ''
  } catch (e) {
    const err = e as { stdout?: string }
    return err.stdout ?? String(e)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const unknown = args.filter((a) => a !== '--check')
  if (unknown.length) {
    console.error(`unknown argument: ${unknown.join(' ')}`)
    process.exit(2)
  }
  const docPath = path.join(root, DOC)
  if (!fs.existsSync(docPath)) {
    console.error(`${DOC} is missing`)
    process.exit(1)
  }
  const { fees, funding, headroom } = referenceFees()
  const cli = validateTemplatesOutput()
  confirmCli(cli, funding)
  const hotelFile = templateFiles().find((f) => loadTemplate(f).templateId.endsWith('hotel@2'))
  if (!hotelFile) throw new Error('templates/ has no hotel@2 template')
  const hotel = loadTemplate(hotelFile)
  const stay = staysFor(hotel, funding, fees)
  const generated = render(cli, hotel.templateId, stay, fees, funding, headroom, accountDeleteSpecial(fees), ages())
  const next = splice(read(DOC), generated)
  const problems = proseProblems(next)
  if (problems.length) {
    console.error('costs: prose citations failed')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  const current = read(DOC)
  if (check) {
    if (current !== next) {
      console.error('costs: docs/costs.md drifted. Run npm run costs and commit the result.')
      console.error(unified(current, next))
      process.exit(1)
    }
    console.log('costs: ok')
    return
  }
  if (current !== next) fs.writeFileSync(docPath, next)
  console.log(current === next ? 'costs: ok (unchanged)' : 'costs: wrote docs/costs.md')
}

main()

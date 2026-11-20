// Check docs/trust-model.md and the README first-screen link.
//
// Citations in the page are for readers: `Symbol` (`path:line`).
// This script checks that each cited path exists and that the file contains the named symbol.
// It does not check the line number.
//
// Banned words are a product copy rule: no overclaiming.
// Match on word boundaries, case-insensitive, so "security" and "insecure" pass and "Secure" fails.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Product copy rule: no overclaiming. Whole words only, case-insensitive. */
export const BANNED_WORDS = ['production-ready', 'secure', 'audited'] as const

const PHRASE = 'ledger-enforced quorum plus policy co-signer'
const ENV_NAMES = ['ENG_RLUSD_ISSUER', 'ENG_ARBITER_ACCREDITOR', 'ENG_KYB_ISSUER'] as const
const REQUIRED_SYMBOLS = [
  'KNOWN_SLOTS',
  'loadTrustConfig',
  'canonicalTrust',
  'neutralityFindings',
  'signsStage',
  'minimalWinningSets',
  'buildDisableMasterPlain',
  'signerProviderFromEnv',
] as const

const CITE = /`([A-Za-z_][A-Za-z0-9_]*)`\s*\(`([^`\s]+):(\d+)`\)/g
const PATH_OK = /^(?:\.env\.example|(?:packages|templates|policies|scripts|docs)\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+\.(?:ts|json|md))$/

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Banned words present in `text`. "security" and "insecure" are not hits. "Secure" is. */
export function bannedWordsIn(text: string): string[] {
  const hits: string[] = []
  for (const word of BANNED_WORDS) {
    if (new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(text)) hits.push(word)
  }
  return hits
}

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function firstScreen(readme: string): string {
  const lines = readme.split('\n')
  const idx = lines.findIndex((line) => line === '---')
  if (idx < 0) throw new Error('README.md has no first-screen ---')
  return lines.slice(0, idx).join('\n')
}

function symbolInFile(symbol: string, text: string): boolean {
  return new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(text)
}

function checkPage(problems: string[]): void {
  const rel = 'docs/trust-model.md'
  if (!fs.existsSync(path.join(root, rel))) {
    problems.push(`${rel}: missing`)
    return
  }
  const doc = read(rel)
  if (!doc.includes(PHRASE)) problems.push(`${rel}: missing phrase ${JSON.stringify(PHRASE)}`)
  if (!doc.includes('Testnet')) problems.push(`${rel}: missing Testnet`)
  for (const name of ENV_NAMES) if (!doc.includes(name)) problems.push(`${rel}: missing ${name}`)
  const banned = bannedWordsIn(doc)
  if (banned.length) problems.push(`${rel}: banned words ${banned.join(', ')}`)

  const cited = new Map<string, Set<string>>()
  const seen = new Set<string>()
  for (const match of doc.matchAll(CITE)) {
    const symbol = match[1]
    const file = match[2]
    const key = `${symbol}\0${file}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!PATH_OK.test(file)) {
      problems.push(`${rel}: citation path not allowed: ${file}`)
      continue
    }
    const abs = path.join(root, file)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      problems.push(`${rel}: cited file missing: ${file} (${symbol})`)
      continue
    }
    const source = fs.readFileSync(abs, 'utf8')
    if (!symbolInFile(symbol, source)) problems.push(`${rel}: ${file} does not contain ${symbol}`)
    const files = cited.get(symbol) ?? new Set<string>()
    files.add(file)
    cited.set(symbol, files)
  }
  for (const symbol of REQUIRED_SYMBOLS) {
    if (!cited.has(symbol)) problems.push(`${rel}: missing citation for ${symbol}`)
  }
}

function checkReadme(problems: string[]): void {
  const screen = firstScreen(read('README.md'))
  const hits = screen.split('docs/trust-model.md').length - 1
  if (hits !== 1) problems.push(`README first screen: docs/trust-model.md appears ${hits} times (want 1)`)
}

function main(): void {
  const textFlag = process.argv.indexOf('--check-text')
  if (textFlag !== -1) {
    const text = process.argv[textFlag + 1]
    if (text === undefined) {
      console.error('--check-text needs a string')
      process.exit(2)
    }
    const hits = bannedWordsIn(text)
    if (hits.length) {
      console.log(`banned: ${hits.join(', ')}`)
      process.exit(1)
    }
    console.log('no banned words')
    return
  }
  const problems: string[] = []
  checkReadme(problems)
  checkPage(problems)
  if (problems.length) {
    for (const p of problems) console.error(p)
    process.exit(1)
  }
  console.log('ok')
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) main()

// Local agent seed. AGENT_SEED wins over AGENT_SEED_FILE.
// The seed value is never placed in an error or a notice.
import fs from 'node:fs'

export const SEED_FILE_IGNORED = 'AGENT_SEED is in use; AGENT_SEED_FILE is ignored'

export function resolveAgentSeed(env: NodeJS.ProcessEnv, opts: {
  warn?: (line: string) => void
  readFile?: (file: string) => string
} = {}): string {
  const fromEnv = env.AGENT_SEED?.trim() ?? ''
  const filePath = env.AGENT_SEED_FILE?.trim() ?? ''
  if (fromEnv) {
    if (filePath) (opts.warn ?? ((line: string) => console.error(line)))(SEED_FILE_IGNORED)
    return fromEnv
  }
  if (!filePath) throw new Error('missing required env AGENT_SEED')
  const readFile = opts.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'))
  let text: string
  try {
    text = readFile(filePath)
  } catch {
    throw new Error(`AGENT_SEED_FILE is not readable: ${filePath}`)
  }
  const seed = text.trim()
  if (!seed || /[\r\n]/.test(seed)) throw new Error(`AGENT_SEED_FILE must be one line: ${filePath}`)
  return seed
}

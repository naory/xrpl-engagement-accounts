// Bearer for the local co-signer. COSIGNER_API_TOKEN wins over a token file.
// The token value is never placed in an error or a notice.
import fs from 'node:fs'

export const TOKEN_FILE_IGNORED = 'COSIGNER_API_TOKEN is in use; COSIGNER_API_TOKEN_FILE is ignored'

export function resolveCosignerToken(env: NodeJS.ProcessEnv, opts: {
  /** Explicit file. Wins over COSIGNER_API_TOKEN_FILE when the env token is unset. */
  filePath?: string
  warn?: (line: string) => void
  readFile?: (file: string) => string
} = {}): string | null {
  const fromEnv = env.COSIGNER_API_TOKEN?.trim() ?? ''
  const filePath = opts.filePath?.trim() || env.COSIGNER_API_TOKEN_FILE?.trim() || ''
  if (fromEnv) {
    if (filePath) (opts.warn ?? ((line: string) => console.error(line)))(TOKEN_FILE_IGNORED)
    return fromEnv
  }
  if (!filePath) return null
  const readFile = opts.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'))
  let text: string
  try {
    text = readFile(filePath)
  } catch {
    throw new Error(`COSIGNER_API_TOKEN_FILE is not readable: ${filePath}`)
  }
  const token = text.trim()
  if (!token || /[\r\n]/.test(token)) throw new Error(`COSIGNER_API_TOKEN_FILE must be one line: ${filePath}`)
  return token
}

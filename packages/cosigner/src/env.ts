// Minimal .env loader — no dependency. Loads KEY=VALUE pairs from a .env file into process.env
// WITHOUT overriding variables already set in the environment (so an inline `VAR=x npm run …` still
// wins). Keeps the long demo/pool config out of the command line. The .env file is gitignored; never
// commit real seeds. Supports `export KEY=...`, # comments (whole-line and trailing), and quotes.
import fs from 'node:fs'
import path from 'node:path'

export function loadEnv(dirs: string[] = []): void {
  const seen = new Set<string>()
  for (const dir of [process.cwd(), ...dirs]) {
    const file = path.join(dir, '.env')
    if (seen.has(file)) continue
    seen.add(file)
    let text: string
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/^\s*export\s+/, '')
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (!m) continue
      const key = m[1]
      if (key in process.env) continue // never override an explicitly-set var
      let val = m[2].split(/\s+#/)[0].trim() // strip trailing ` # comment`
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
      process.env[key] = val
    }
  }
}

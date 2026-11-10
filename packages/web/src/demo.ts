// `npm run demo` — one-command launcher for the web demo:
//   1) load repo-root .env   2) free the port if a previous server is still holding it
//   3) pooled-mode readiness check (warn if no ready account to lease)   4) start the server.
// A thin convenience wrapper around `npm run web`; the server itself is packages/web/src/server.ts.
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv, FilePoolStateStore } from '@eng/cosigner'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
loadEnv([root])
const PORT = Number(process.env.PORT ?? 8080)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// 1) free the port (POSIX: lsof + kill). Harmless if nothing is listening or lsof is unavailable.
try {
  const pids = execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  if (pids) {
    execSync(`kill ${pids.split('\n').join(' ')}`)
    console.log(`freed port ${PORT} (stopped pid ${pids.split('\n').join(', ')})`)
    await sleep(600)
  }
} catch { /* nothing listening, or no lsof — carry on */ }

// 2) pooled-mode readiness: warn (don't block) if there's no ready account to lease.
if (process.env.ENG_USE_POOL === '1' || process.env.ENG_USE_POOL === 'true') {
  try {
    const state = new FilePoolStateStore(path.join(root, process.env.ENG_POOL_DIR ?? '.pool', 'state.json'))
    const all = await state.all()
    const ready = all.filter((a) => a.status === 'ready').length
    const aging = all.filter((a) => a.status === 'aging').length
    if (ready === 0) console.warn(`\n⚠ pool: 0 ready (${aging} aging) — provision will fail until one ages.\n  → npm run pool:ensure   (then wait ~7 min and reload the page)\n`)
    else console.log(`pool: ${ready} ready, ${aging} aging`)
  } catch { /* no pool store yet — self-contained mode or first run */ }
}

// 3) start the server (importing it runs server.listen()).
await import('./server.ts')

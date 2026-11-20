// Entrypoint for `npm run eng -- open`. The packed bin is src/bin/eng.ts, which
// calls startEng(). Importing this file does not start the CLI.
import path from 'node:path'
import { defaultEngIo, runEng } from './eng-cli.ts'

export function startEng(): Promise<number> {
  return runEng(process.argv.slice(2), defaultEngIo())
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href

if (isEntrypoint) {
  startEng().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error((error as Error).message ?? String(error))
      process.exit(1)
    },
  )
}

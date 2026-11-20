// Entrypoint for `npm run eng -- open`.
import path from 'node:path'
import { defaultEngIo, runEng } from './eng-cli.ts'

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href

if (isEntrypoint) {
  runEng(process.argv.slice(2), defaultEngIo()).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error((error as Error).message ?? String(error))
      process.exit(1)
    },
  )
}

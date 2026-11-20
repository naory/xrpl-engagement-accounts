#!/usr/bin/env node
// Packed entry for `eng open`. Notices stay on stderr.
import { startEng } from '../eng.ts'

startEng().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error((error as Error).message ?? String(error))
    process.exit(1)
  },
)

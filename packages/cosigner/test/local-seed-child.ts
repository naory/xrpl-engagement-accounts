// Child for the concurrent first-run test. Prints the sha256 of the seed, never the seed.
// Usage: node --conditions=source --import tsx local-seed-child.ts <dataDir>
import { createHash } from 'node:crypto'
import { ensureLocalSeed } from '../src/local.ts'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: local-seed-child.ts <dataDir>')
  process.exit(2)
}
const seed = ensureLocalSeed(dir)
process.stdout.write(createHash('sha256').update(seed).digest('hex'))

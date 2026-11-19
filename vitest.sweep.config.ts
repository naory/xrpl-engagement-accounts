import { defineConfig } from 'vitest/config'

// The hotel fix-round-4 sweep (R20, R21) is excluded from the default run
// (see vitest.config.ts). The nightly workflow runs `npm run test:sweep`.
export default defineConfig({ test: { include: ['packages/cosigner/test/**/*.sweep.test.ts'] } })

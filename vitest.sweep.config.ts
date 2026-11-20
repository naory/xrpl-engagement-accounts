import { defineConfig } from 'vitest/config'
import { sourceConditionPlugin, sourceConditions, sourceNodeOptions } from './vitest.conditions.ts'

// The hotel fix-round-4 sweep (R20, R21) is excluded from the default run
// (see vitest.config.ts). The nightly workflow runs `npm run test:sweep`.
export default defineConfig({
  plugins: [sourceConditionPlugin()],
  resolve: { conditions: sourceConditions },
  test: {
    include: ['packages/cosigner/test/**/*.sweep.test.ts'],
    env: { NODE_OPTIONS: sourceNodeOptions() },
  },
})

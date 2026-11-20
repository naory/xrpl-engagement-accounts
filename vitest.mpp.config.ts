import { defineConfig } from 'vitest/config'
import { sourceConditionPlugin, sourceConditions, sourceNodeOptions } from './vitest.conditions.ts'
// The MPP demo tests depend on `x402-xrpl-settlement-adapter` (the push →
// confirmExactSettlement bridge; see packages/cosigner/demo/mpp/README.md). The
// reference `xrpl-mpp-sdk` is NOT a dependency — it peers on xrpl<5 while this
// repo is on xrpl@5 (see docs/research/mpp.md §6). Kept out of the default run.
export default defineConfig({
  plugins: [sourceConditionPlugin()],
  resolve: { conditions: sourceConditions },
  test: {
    include: ['packages/cosigner/demo/mpp/**/*.test.ts'],
    env: { NODE_OPTIONS: sourceNodeOptions() },
  },
})

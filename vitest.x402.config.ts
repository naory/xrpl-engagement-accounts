import { defineConfig } from 'vitest/config'
import { sourceConditionPlugin, sourceConditions, sourceNodeOptions } from './vitest.conditions.ts'
// The x402 demo tests depend on `x402-xrpl-settlement-adapter` (install it first;
// see packages/cosigner/demo/x402/README.md). Kept out of the default run.
export default defineConfig({
  plugins: [sourceConditionPlugin()],
  resolve: { conditions: sourceConditions },
  test: {
    include: ['packages/cosigner/demo/x402/**/*.test.ts'],
    env: { NODE_OPTIONS: sourceNodeOptions() },
  },
})

import { defineConfig } from 'vitest/config'
import { sourceConditionPlugin, sourceConditions, sourceNodeOptions } from './vitest.conditions.ts'

// Opt-in Testnet e2e for `eng open`. Kept out of npm test.
export default defineConfig({
  plugins: [sourceConditionPlugin()],
  resolve: { conditions: sourceConditions },
  test: {
    include: ['packages/agent-mcp/demo/open.e2e.ts'],
    env: { NODE_OPTIONS: sourceNodeOptions() },
  },
})

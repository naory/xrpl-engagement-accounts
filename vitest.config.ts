import { configDefaults, defineConfig } from 'vitest/config'
import { sourceConditionPlugin, sourceConditions, sourceNodeOptions } from './vitest.conditions.ts'

// `*.sweep.test.ts` is the hotel R20/R21 sweep. It stays out of `npm test`
// (the PR suite) and runs from vitest.sweep.config.ts.
export default defineConfig({
  plugins: [sourceConditionPlugin()],
  resolve: { conditions: sourceConditions },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.sweep.test.ts'],
    env: { NODE_OPTIONS: sourceNodeOptions() },
  },
})

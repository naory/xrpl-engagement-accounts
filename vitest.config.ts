import { configDefaults, defineConfig } from 'vitest/config'

// `*.sweep.test.ts` is the hotel R20/R21 sweep. It stays out of `npm test`
// (the PR suite) and runs from vitest.sweep.config.ts.
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.sweep.test.ts'],
  },
})

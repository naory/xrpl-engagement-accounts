import { defineConfig } from 'vitest/config'
// The x402 demo tests depend on `x402-xrpl-settlement-adapter` (install it first;
// see packages/cosigner/demo/x402/README.md). Kept out of the default run.
export default defineConfig({ test: { include: ['packages/cosigner/demo/x402/**/*.test.ts'] } })

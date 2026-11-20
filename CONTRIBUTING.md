# Contributing

Thanks for your interest. This is the open trust-primitives layer of the
project; contributions that strengthen the validator, the policy engine, the
co-signer, the policies, or the conformance vectors are especially welcome.

## Development setup

Requires **Node ≥ 22.13** (the co-signer store uses the built-in `node:sqlite`).

```bash
npm install
npm test                 # core, policy, co-signer, conformance vectors
npm run test:sweep       # hotel R20/R21 sweep (nightly; not part of npm test)
npm run typecheck
npm run validate-templates   # V1–V15 over templates/*.json
npm run lint-policies        # L1–L3, L5, L7–L9 over policies/*.json (L4 and L6 are not implemented)
npm run check-counts         # documented test and vector counts match the repo
```

Each documented count is written once. The marker is the comment
`<!-- count:NAME -->`, then the digits, then `<!-- /count -->`.
`npm run check-counts` compares those markers with the repo. The
default-suite total is on the `npm test` line in the README. The vector
counts are in [`vectors/README.md`](vectors/README.md). The `tests`
marker is `npm test` only. `test:x402` and `test:mpp` are separate
suites. When `vitest.sweep.config.ts` is present, those tests are their
own marker (`tests-sweep`) and are not part of `tests`.

The x402 demo and its test depend on `x402-xrpl-settlement-adapter` (a
devDependency, installed by `npm install`):

```bash
npm run test:x402            # in-process merchant integration test
npm run typecheck:x402
```

Live Testnet demos (`demo:b1`, `demo:x402`) need a machine that can reach XRPL
Testnet and are not part of CI.

## Conformance vectors are deterministic

`vectors/*.json` are generated from `vectors/cases.ts`, the fixtures and the
shipped policies. They must round-trip byte-for-byte:

```bash
npm run vectors:build        # rewrites vectors/*.json
git diff -- vectors          # must be empty on an unrelated change
```

If a change alters behaviour, rebuild the vectors in the same PR and review the
diff — it is the normative record of the change. CI fails if a build would
change `vectors/` without it being committed.

## Tests

- Add or update tests with every behaviour change; policy changes need
  conformance-vector coverage.
- When you add or remove tests or vectors, update the matching count marker. `npm run check-counts` checks it.
- The whole default suite must pass (`npm test`) and typecheck cleanly. The hotel R20/R21 sweep is `npm run test:sweep`; it is not part of `npm test` (nightly CI runs it).
- The CI `npm audit --audit-level=high` step is blocking. If an unrelated PR goes red from a new advisory, fix it with a dependency bump PR, never by re-adding `|| true`.
- Keys and seeds in tests are **test-only**, derived from public strings. Never
  commit a real key or seed, and never fund a fixture account.

## Pull requests

- Keep PRs focused; describe the behaviour change and link any issue.
- Conventional-commit-style subjects are appreciated (`feat(policy): …`,
  `docs: …`, `chore: …`).
- By contributing you agree your contribution is licensed under the repo's
  [Apache-2.0 license](LICENSE).

## Security

Do not file security issues publicly — see [SECURITY.md](SECURITY.md).

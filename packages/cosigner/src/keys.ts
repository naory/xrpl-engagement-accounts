// Co-signer key custody — a seam so the signing key isn't hard-wired to an
// environment seed. The M1 default reads a test seed from the environment; the
// same interface lets a deployment plug in a seed file or (later) an HSM/KMS
// provider and an accredited `ENG/COSIGNER` credential without touching the
// service.
import fs from 'node:fs'
import xrpl from 'xrpl'

export interface KeyProvider {
  /** Where the key comes from, for logs/audit: e.g. `env`, `file`, `kms`. */
  readonly source: string
  /** Resolve the co-signer wallet. May be async (e.g. a KMS fetch). */
  getWallet(): Promise<InstanceType<typeof xrpl.Wallet>>
}

/** A fixed, already-loaded wallet (tests, or a caller that manages custody itself). */
export function staticKeyProvider(
  wallet: InstanceType<typeof xrpl.Wallet>,
  source = 'static',
): KeyProvider {
  return { source, getWallet: async () => wallet }
}

/**
 * Resolve a {@link KeyProvider} from the environment, in order:
 *  - `COSIGNER_SEED`        — a seed string (test/dev; never commit it);
 *  - `COSIGNER_SEED_FILE`   — a file containing only the seed (0600), preferred
 *                             over an inline env var for process-listing hygiene.
 *
 * Production custody (HSM/KMS) is a future provider implementing the same
 * interface; wire it here behind a `COSIGNER_KEY_SOURCE=kms` branch. It is not
 * implemented in this layer, which never holds production keys.
 */
export function keyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): KeyProvider {
  const source = env.COSIGNER_KEY_SOURCE
  if (source === 'kms') {
    throw new Error(
      'COSIGNER_KEY_SOURCE=kms: no KMS/HSM provider is bundled in this layer; ' +
        'implement a KeyProvider and pass it to the server explicitly.',
    )
  }
  if (env.COSIGNER_SEED_FILE) {
    const seed = fs.readFileSync(env.COSIGNER_SEED_FILE, 'utf8').trim()
    if (!seed) throw new Error('COSIGNER_SEED_FILE is empty')
    return { source: 'file', getWallet: async () => xrpl.Wallet.fromSeed(seed) }
  }
  if (env.COSIGNER_SEED) {
    const seed = env.COSIGNER_SEED
    return { source: 'env', getWallet: async () => xrpl.Wallet.fromSeed(seed) }
  }
  throw new Error('no co-signer key: set COSIGNER_SEED or COSIGNER_SEED_FILE (test-only seeds)')
}

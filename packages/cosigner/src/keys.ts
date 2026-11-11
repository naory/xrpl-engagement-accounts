// Co-signer key custody — a seam so the signing key isn't hard-wired to an environment seed, and
// isn't even required to be exportable. The default reads a test seed; the same interface lets a
// deployment plug in a Privy-custodied key (sign-not-export) or, later, an HSM/KMS provider.
import fs from 'node:fs'
import xrpl from 'xrpl'
import { localSigner, type Signer } from '@eng/core'
import { privySignerFromEnv } from './privy-signer.ts'

export interface SignerProvider {
  /** Where the key comes from, for logs/audit: e.g. `env`, `file`, `privy`, `kms`. */
  readonly source: string
  /** Resolve the co-signer's {@link Signer}. May be async (e.g. a KMS/Privy fetch). */
  getSigner(): Promise<Signer>
}

/** A fixed, already-loaded signer (tests, or a caller that manages custody itself). */
export function staticSignerProvider(signer: Signer, source = 'static'): SignerProvider {
  return { source, getSigner: async () => signer }
}

/**
 * Resolve a {@link SignerProvider} from the environment, in order:
 *  - `COSIGNER_KEY_SOURCE=privy` — a Privy-custodied key (`PRIVY_*` env); never exported;
 *  - `COSIGNER_SEED_FILE`        — a file containing only the seed (0600);
 *  - `COSIGNER_SEED`             — an inline seed (test/dev; never commit it).
 *
 * HSM/KMS is a future provider implementing the same interface; wire it behind
 * `COSIGNER_KEY_SOURCE=kms`. This layer never holds production keys.
 */
export function signerProviderFromEnv(env: NodeJS.ProcessEnv = process.env): SignerProvider {
  if (env.COSIGNER_KEY_SOURCE === 'kms') {
    throw new Error(
      'COSIGNER_KEY_SOURCE=kms: no KMS/HSM provider is bundled in this layer; ' +
        'implement a SignerProvider and pass it to the server explicitly.',
    )
  }
  if (env.COSIGNER_KEY_SOURCE === 'privy') {
    const signer = privySignerFromEnv(env)
    if (!signer) throw new Error('COSIGNER_KEY_SOURCE=privy but PRIVY_* env is not set (need PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_ID, PRIVY_WALLET_ADDRESS, PRIVY_WALLET_PUBKEY)')
    return { source: 'privy', getSigner: async () => signer }
  }
  if (env.COSIGNER_SEED_FILE) {
    const seed = fs.readFileSync(env.COSIGNER_SEED_FILE, 'utf8').trim()
    if (!seed) throw new Error('COSIGNER_SEED_FILE is empty')
    return { source: 'file', getSigner: async () => localSigner(xrpl.Wallet.fromSeed(seed)) }
  }
  if (env.COSIGNER_SEED) {
    const seed = env.COSIGNER_SEED
    return { source: 'env', getSigner: async () => localSigner(xrpl.Wallet.fromSeed(seed)) }
  }
  throw new Error('no co-signer key: set COSIGNER_SEED, COSIGNER_SEED_FILE, or COSIGNER_KEY_SOURCE=privy')
}

// Exact money: integer minor units per asset. No floats anywhere (policy spec P6).

export interface AssetDef {
  /** Short code used in policies, e.g. "RLUSD". */
  code: string
  kind: 'IOU' | 'XRP'
  /** XRPL currency field (3-char or 40-hex). */
  currency: string
  issuer?: string
  /** Minor-unit precision, e.g. 6 for RLUSD-style assets (MPCP XRPL stablecoin profile). */
  decimals: number
}

export class Amount {
  readonly asset: string
  readonly minor: bigint
  constructor(asset: string, minor: bigint) {
    this.asset = asset
    this.minor = minor
  }
  add(o: Amount): Amount { sameAsset(this, o); return new Amount(this.asset, this.minor + o.minor) }
  sub(o: Amount): Amount { sameAsset(this, o); return new Amount(this.asset, this.minor - o.minor) }
  cmp(o: Amount): number { sameAsset(this, o); return this.minor < o.minor ? -1 : this.minor > o.minor ? 1 : 0 }
  isZero(): boolean { return this.minor === 0n }
  toJSON(): { asset: string; minor: string } { return { asset: this.asset, minor: this.minor.toString() } }
  toString(): string { return `${this.minor} ${this.asset}(minor)` }
}

export class AssetMismatchError extends Error {
  constructor(a: string, b: string) { super(`asset mismatch: ${a} vs ${b}`) }
}

export function sameAsset(a: Amount, b: Amount): void {
  if (a.asset !== b.asset) throw new AssetMismatchError(a.asset, b.asset)
}

export function zero(asset: string): Amount { return new Amount(asset, 0n) }

/**
 * Parse a decimal string ("412", "409.94", "1e-6", "-3.5") into minor units.
 * Throws if the value has more fractional digits than the asset allows.
 */
export function parseAmount(value: string, asset: AssetDef): Amount {
  return new Amount(asset.code, toMinor(value, asset.decimals))
}

export function toMinor(value: string, decimals: number): bigint {
  const v = value.trim()
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(v)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`invalid decimal: ${value}`)
  const sign = m[1] === '-' ? -1n : 1n
  let intPart = m[2] || '0'
  let frac = m[3] ?? ''
  let exp = m[4] ? Number(m[4]) : 0
  // shift by exponent
  if (exp > 0) {
    const take = frac.slice(0, exp).padEnd(exp, '0')
    intPart = intPart + take
    frac = frac.slice(exp)
  } else if (exp < 0) {
    const n = -exp
    const padded = intPart.padStart(n + 1, '0')
    frac = padded.slice(padded.length - n) + frac
    intPart = padded.slice(0, padded.length - n)
  }
  frac = frac.replace(/0+$/, '')
  if (frac.length > decimals) throw new Error(`too many decimals for precision ${decimals}: ${value}`)
  const minor = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt((frac || '0').padEnd(decimals, '0'))
  return sign * minor
}

export function formatAmount(a: Amount, decimals: number): string {
  const neg = a.minor < 0n
  const abs = neg ? -a.minor : a.minor
  const s = abs.toString().padStart(decimals + 1, '0')
  const int = s.slice(0, s.length - decimals)
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, '') : ''
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`
}

/** Basis points of an amount, rounded DOWN to the minor unit (policy spec §4). */
export function bps(a: Amount, n: bigint): Amount {
  return new Amount(a.asset, (a.minor * n) / 10000n)
}

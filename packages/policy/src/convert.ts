// CEL works with BigInt integers; JSON numbers would become doubles (which cel-eng/1 bans).
// Deep-convert plain data so integers become BigInt and nested objects stay maps.
import { Amount } from '@eng/core'

export function toCel(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`non-integer number not allowed in policy inputs: ${value}`)
    return BigInt(value)
  }
  if (typeof value === 'bigint' || typeof value === 'string' || typeof value === 'boolean') return value
  if (value instanceof Date || value instanceof Amount) return value
  if (Array.isArray(value)) return value.map(toCel)
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value // custom CEL types pass through
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = toCel(v)
    return out
  }
  return value
}

/** Inverse for logging: BigInt → string, Amount → {asset, minor}. */
export function fromCel(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Amount) return value.toJSON()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(fromCel)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fromCel(v)
    return out
  }
  return value
}

// RFC 8785 JSON Canonicalization Scheme, restricted to the value space we allow in statements:
// objects, arrays, strings, booleans, null and SAFE INTEGERS. Non-integer numbers and bigints are
// rejected: amounts travel as decimal strings, never as JSON numbers (policy spec P6).

export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Error(`JCS: only safe integers allowed, got ${value}`)
      return String(value)
    case 'bigint':
      throw new Error('JCS: bigint not allowed (encode amounts as strings)')
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'
      if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
        return canonicalize((value as { toJSON: () => unknown }).toJSON())
      }
      const obj = value as Record<string, unknown>
      // RFC 8785 sorts by UTF-16 code units, which is JavaScript's default string comparison.
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}'
    }
    default:
      throw new Error(`JCS: unsupported type ${typeof value}`)
  }
}

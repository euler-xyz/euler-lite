/**
 * Bigint-safe JSON wire format for snapshot payloads.
 *
 * JSON cannot serialise `bigint` natively. The encoder walks the object tree
 * and replaces every `bigint` with a single-key object `{ __bi: "<decimal>" }`;
 * the decoder reverses it. No schema knowledge required — works for any
 * nested shape, including arrays and plain objects.
 *
 * Adversary safety: vault `name()` / `symbol()` come from on-chain ERC20
 * metadata; a malicious deployer can set them to any string. A prefix
 * encoding (`"__bi:<n>"`) would let those strings silently round-trip as
 * bigints. The object wrapper — exactly one key named `__bi` whose value
 * is a signed decimal string — is unforgeable by any string field. Other
 * shapes (e.g. `{ __bi: '1', extra: true }` or `{ __bi: 'not-a-number' }`)
 * round-trip as plain data.
 */

type AnyRecord = Record<string, unknown>

const BI_TAG = '__bi'

/**
 * Encoder accepts both plain objects and class instances — vault entities
 * (EVault, EulerEarn, SecuritizeCollateralVault) arrive as class instances
 * with bigint fields. JSON loses their prototype anyway; the client
 * re-instantiates via `new EVault(args)`.
 */
const isWalkableObject = (v: unknown): v is AnyRecord =>
  typeof v === 'object'
  && v !== null
  && !Array.isArray(v)

/**
 * Decoder is stricter: only a single-key plain object tagged `__bi: "<dec>"`
 * counts as a bigint marker. Other "tag-shaped" inputs round-trip as data.
 */
const isPlainObject = (v: unknown): v is AnyRecord =>
  typeof v === 'object'
  && v !== null
  && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype

const isBigintTag = (v: unknown): v is { [BI_TAG]: string } => {
  if (!isPlainObject(v)) return false
  const keys = Object.keys(v)
  if (keys.length !== 1 || keys[0] !== BI_TAG) return false
  const payload = (v as AnyRecord)[BI_TAG]
  return typeof payload === 'string' && /^-?\d+$/.test(payload)
}

export function encodeBigints<T>(value: T): unknown {
  if (typeof value === 'bigint') return { [BI_TAG]: value.toString() }
  if (Array.isArray(value)) return value.map(item => encodeBigints(item))
  if (isWalkableObject(value)) {
    const out: AnyRecord = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = encodeBigints(v)
    }
    return out
  }
  return value
}

export function decodeBigints<T = unknown>(value: unknown): T {
  if (isBigintTag(value)) {
    return BigInt(value[BI_TAG]) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map(item => decodeBigints(item)) as unknown as T
  }
  if (isPlainObject(value)) {
    const out: AnyRecord = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = decodeBigints(v)
    }
    return out as unknown as T
  }
  return value as T
}

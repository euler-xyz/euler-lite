import { getAddress, hexToBytes, isAddress, isHex, keccak256, toBytes, type Hash } from 'viem'

export type CanonicalPrimitive = null | boolean | string | number | bigint
export type CanonicalValue = CanonicalPrimitive | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue }

const textEncoder = new TextEncoder()
const MAX_CANONICAL_DEPTH = 128

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

const byte = (value: number) => Uint8Array.of(value)

const uint32 = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`Canonical length is out of range: ${value}`)
  }
  const result = new Uint8Array(4)
  new DataView(result.buffer).setUint32(0, value, false)
  return result
}

const lengthPrefixed = (value: Uint8Array) => concat([uint32(value.length), value])

const bigintMagnitude = (value: bigint): Uint8Array => {
  const absolute = value < 0n ? -value : value
  if (absolute === 0n) return new Uint8Array()
  const hex = absolute.toString(16).padStart(Math.ceil(absolute.toString(16).length / 2) * 2, '0')
  return hexToBytes(`0x${hex}`)
}

const encodeInteger = (tag: number, value: bigint) => concat([
  byte(tag),
  byte(value < 0n ? 1 : 0),
  lengthPrefixed(bigintMagnitude(value)),
])

const assertPlainRecord = (value: object, path: string) => {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain object`)
  }
  if ('__v_isRef' in value) {
    throw new Error(`${path} must not contain a Vue ref`)
  }
}

const encodeCanonicalInner = (value: unknown, path: string, depth: number): Uint8Array => {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new Error(`${path} exceeds the maximum canonical depth`)
  }
  if (value === null) return byte(0x00)
  if (typeof value === 'boolean') return Uint8Array.of(0x01, value ? 1 : 0)
  if (typeof value === 'bigint') return encodeInteger(0x03, value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${path} must be a safe integer`)
    }
    return encodeInteger(0x04, BigInt(value))
  }
  if (typeof value === 'string') {
    if (isAddress(value)) {
      return concat([byte(0x07), hexToBytes(getAddress(value))])
    }
    if (isHex(value)) {
      return concat([byte(0x08), lengthPrefixed(hexToBytes(value))])
    }
    return concat([byte(0x02), lengthPrefixed(textEncoder.encode(value))])
  }
  if (Array.isArray(value)) {
    return concat([
      byte(0x05),
      uint32(value.length),
      ...value.map((entry, index) => encodeCanonicalInner(entry, `${path}[${index}]`, depth + 1)),
    ])
  }
  if (typeof value === 'object') {
    assertPlainRecord(value, path)
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return concat([
      byte(0x06),
      uint32(keys.length),
      ...keys.flatMap(key => [
        lengthPrefixed(textEncoder.encode(key)),
        encodeCanonicalInner(record[key], `${path}.${key}`, depth + 1),
      ]),
    ])
  }
  throw new Error(`${path} contains unsupported ${typeof value} data`)
}

/**
 * Schema-versioned canonical binary encoding. Object keys are sorted, arrays
 * preserve order, addresses are normalized to 20 bytes, and integers use an
 * explicit sign/magnitude representation. JSON serialization is not involved.
 */
export const encodeCanonical = (schema: string, value: CanonicalValue): Uint8Array => concat([
  byte(0x43),
  lengthPrefixed(toBytes(schema)),
  encodeCanonicalInner(value, '$', 0),
])

export const canonicalDigest = (schema: string, value: CanonicalValue): Hash =>
  keccak256(encodeCanonical(schema, value))

export function assertCanonicalValue(value: unknown, path = '$'): asserts value is CanonicalValue {
  encodeCanonicalInner(value, path, 0)
}

export const deepFreezeCanonical = <T extends CanonicalValue>(value: T): T => {
  assertCanonicalValue(value)
  if (value && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      deepFreezeCanonical(child)
    }
    Object.freeze(value)
  }
  return value
}

/** Clone ordinary SDK/API DTO data into the canonical value domain. */
export const toCanonicalValue = (value: unknown, path = '$', depth = 0): CanonicalValue => {
  if (depth > MAX_CANONICAL_DEPTH) throw new Error(`${path} exceeds the maximum canonical depth`)
  if (value === null) return null
  if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${path} must be a safe integer`)
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => toCanonicalValue(entry, `${path}[${index}]`, depth + 1))
  }
  if (typeof value === 'object') {
    assertPlainRecord(value, path)
    const result: Record<string, CanonicalValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue
      result[key] = toCanonicalValue(entry, `${path}.${key}`, depth + 1)
    }
    return result
  }
  throw new Error(`${path} contains unsupported ${typeof value} data`)
}

export const deepFreezeSerializable = <T>(value: T): Readonly<T> => {
  const canonical = toCanonicalValue(value)
  deepFreezeCanonical(canonical)
  return canonical as Readonly<T>
}

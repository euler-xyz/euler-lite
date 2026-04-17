/**
 * Bigint-safe JSON wire format for ChainVaultsSnapshot.
 *
 * JSON cannot serialise bigint natively. The encoder walks the object tree
 * and replaces every bigint with a single-key object `{ __bi: "<decimal>" }`;
 * the decoder walks the mirror structure and reverses it. No schema
 * knowledge required — works for any nested shape, including arrays and
 * plain objects.
 *
 * The object-wrapper form is important vs a prefix-on-a-string: vault
 * fields like `name()` and `symbol()` come from on-chain data and are
 * adversary-controlled. If the decoder ran `BigInt(s.slice(5))` on any
 * string starting with `__bi:`, a malicious vault could poison the
 * decoded snapshot. An object wrapper with exactly one numeric-string
 * key is not producible as an on-chain string, so only genuine encoder
 * output trips the decoder.
 */

import type { ChainVaultsSnapshot } from './loader'

type AnyRecord = Record<string, unknown>

interface BigintTag { __bi: string }

const isBigintTag = (v: unknown): v is BigintTag => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const keys = Object.keys(v)
  if (keys.length !== 1 || keys[0] !== '__bi') return false
  const payload = (v as AnyRecord).__bi
  return typeof payload === 'string' && /^-?\d+$/.test(payload)
}

const encodeValue = (v: unknown): unknown => {
  if (typeof v === 'bigint') return { __bi: v.toString() }
  if (Array.isArray(v)) return v.map(encodeValue)
  if (v !== null && typeof v === 'object') {
    const out: AnyRecord = {}
    for (const [k, val] of Object.entries(v as AnyRecord)) {
      out[k] = encodeValue(val)
    }
    return out
  }
  return v
}

const decodeValue = (v: unknown): unknown => {
  if (isBigintTag(v)) return BigInt(v.__bi)
  if (Array.isArray(v)) return v.map(decodeValue)
  if (v !== null && typeof v === 'object') {
    const out: AnyRecord = {}
    for (const [k, val] of Object.entries(v as AnyRecord)) {
      out[k] = decodeValue(val)
    }
    return out
  }
  return v
}

/** Opaque wire type. Structurally it's ChainVaultsSnapshot with bigints replaced by `{ __bi: "<decimal>" }` tags. */
export type SerialisedSnapshot = Record<string, unknown>

export const serialiseSnapshot = (snap: ChainVaultsSnapshot): SerialisedSnapshot =>
  encodeValue(snap) as SerialisedSnapshot

export const deserialiseSnapshot = (wire: SerialisedSnapshot): ChainVaultsSnapshot =>
  decodeValue(wire) as ChainVaultsSnapshot

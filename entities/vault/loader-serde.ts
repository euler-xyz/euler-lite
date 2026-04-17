/**
 * Bigint-safe JSON wire format for ChainVaultsSnapshot.
 *
 * JSON cannot serialise bigint natively, so we walk the object tree and
 * replace every bigint with a tagged string (`__bi:<decimal>`). The decode
 * walker reverses it. No schema knowledge required — works for any nested
 * shape, including arrays and plain objects.
 *
 * Do not apply to user-supplied content. These walkers assume trusted
 * server-origin data.
 */

import type { ChainVaultsSnapshot } from './loader'

const BIGINT_PREFIX = '__bi:'

type AnyRecord = Record<string, unknown>

const encodeValue = (v: unknown): unknown => {
  if (typeof v === 'bigint') return `${BIGINT_PREFIX}${v.toString()}`
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
  if (typeof v === 'string' && v.startsWith(BIGINT_PREFIX)) {
    return BigInt(v.slice(BIGINT_PREFIX.length))
  }
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

/** Opaque wire type. Structurally it's ChainVaultsSnapshot with bigints replaced by tagged strings. */
export type SerialisedSnapshot = Record<string, unknown>

export const serialiseSnapshot = (snap: ChainVaultsSnapshot): SerialisedSnapshot =>
  encodeValue(snap) as SerialisedSnapshot

export const deserialiseSnapshot = (wire: SerialisedSnapshot): ChainVaultsSnapshot =>
  decodeValue(wire) as ChainVaultsSnapshot

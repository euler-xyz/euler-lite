import { isAddress } from 'viem'

const LINK_TEXT_KEYS = new Set(['description', 'deprecationReason', 'deprecateReason', 'portfolioNotice'])
const URL_KEYS = new Set(['url'])
const REGEX_KEYS = new Set(['symbolRegex', 'nameRegex'])
const MAX_REGEX_LEN = 512
const LOGO_FILENAME_KEYS = new Set(['logo'])
const SAFE_LOGO_FILENAME_RE = /^[a-zA-Z0-9_-]+\.(svg|png|jpg|jpeg|webp|gif)$/i
const MAX_STRING_LEN = 16_384
const MAX_ARRAY_LEN = 10_000
const MARKDOWN_LINK_INJECTION_RE = /\[[^\]]*\]\(https?:\/\/[^)]*"[^)]*\)/

const isSafeHttpUrl = (value: string): boolean => {
  if (!value) return true
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  }
  catch {
    return false
  }
}

export function validateNode(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    if (node.length > MAX_ARRAY_LEN) {
      throw new Error(`Array too large at ${path}: ${node.length} exceeds ${MAX_ARRAY_LEN}`)
    }
    node.forEach((item, index) => validateNode(item, `${path}[${index}]`))
    return
  }
  if (node === null || typeof node !== 'object') return

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (value.length > MAX_STRING_LEN) {
        throw new Error(`String too long at ${path}.${key}: ${value.length} exceeds ${MAX_STRING_LEN}`)
      }
      if (URL_KEYS.has(key) && !isSafeHttpUrl(value)) {
        throw new Error(`Unsafe URL in ${path}.${key}: protocol must be http or https`)
      }
      if (LOGO_FILENAME_KEYS.has(key) && value !== '' && !SAFE_LOGO_FILENAME_RE.test(value)) {
        throw new Error(`Unsafe logo filename in ${path}.${key}: ${value}`)
      }
      if (LINK_TEXT_KEYS.has(key) && MARKDOWN_LINK_INJECTION_RE.test(value)) {
        throw new Error(`Injection pattern detected in ${path}.${key}`)
      }
      if (REGEX_KEYS.has(key)) {
        if (value.length > MAX_REGEX_LEN) {
          throw new Error(`Invalid regex in ${path}.${key}: pattern exceeds ${MAX_REGEX_LEN} chars`)
        }
        try {
          new RegExp(value)
        }
        catch {
          throw new Error(`Invalid regex in ${path}.${key}: ${value}`)
        }
      }
    }
    else if (value !== null && typeof value === 'object') {
      validateNode(value, `${path}.${key}`)
    }
  }
}

/** Invalid geo fields cannot be silently discarded by permissive SDK normalization. */
export function validateStaticGeo(node: unknown): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) validateStaticGeo(item)
    return
  }
  const row = node as Record<string, unknown>
  for (const key of ['block', 'restricted']) {
    if (row[key] !== undefined && (!Array.isArray(row[key]) || !(row[key] as unknown[]).every(code => typeof code === 'string' && /^[A-Z]{2,4}$/.test(code)))) {
      throw new Error(`Invalid static geo ${key}`)
    }
  }
  for (const key of ['symbolRegex', 'nameRegex']) {
    if (row[key] !== undefined && typeof row[key] !== 'string') throw new Error(`Invalid static ${key}`)
  }
  for (const key of ['symbols', 'names']) {
    if (row[key] !== undefined && (!Array.isArray(row[key]) || !(row[key] as unknown[]).every(item => typeof item === 'string'))) throw new Error(`Invalid static ${key}`)
  }
  if (row.address !== undefined && (typeof row.address !== 'string' || !isAddress(row.address))) throw new Error('Invalid static address')
  for (const child of Object.values(row)) validateStaticGeo(child)
}

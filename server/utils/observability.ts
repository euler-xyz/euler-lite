import { createHash } from 'node:crypto'

type IssueLike = Record<string, unknown>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export function hashIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 16)
}

export function urlHost(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    return new URL(value).host
  }
  catch {
    return undefined
  }
}

export function safePathTemplate(pathname: string): string {
  return pathname
    .split('/')
    .map((part) => {
      if (ADDRESS_RE.test(part)) return ':address'
      if (/^[0-9]+$/.test(part)) return ':number'
      return part
    })
    .join('/')
}

export function searchKeys(params: URLSearchParams): string[] {
  return [...new Set([...params.keys()])].sort()
}

export function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const status = (error as { status?: unknown, statusCode?: unknown }).status
    ?? (error as { status?: unknown, statusCode?: unknown }).statusCode
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

export function summarizeSdkIssue(issue: unknown): Record<string, unknown> {
  if (!issue || typeof issue !== 'object') {
    return { type: typeof issue }
  }

  const src = issue as IssueLike
  const out: Record<string, unknown> = {}
  for (const key of ['code', 'kind', 'severity', 'source', 'type', 'name']) {
    const value = src[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }

  const message = src.message ?? src.shortMessage
  if (typeof message === 'string' && message.trim()) {
    out.message = message.slice(0, 240)
  }

  return Object.keys(out).length ? out : { type: 'sdk-issue' }
}

import { summarizeViemError } from './viem-errors'

const CLIENT_EVENTS = [
  'tx_plan_build_failed',
  'tx_plan_prepare_failed',
  'tx_execute_failed',
  'wallet_modal_unavailable',
  'client_invariant_missing',
] as const

export type ClientObservabilityEvent = typeof CLIENT_EVENTS[number]

export interface ClientObservabilityFields {
  event: ClientObservabilityEvent
  flow?: string
  phase?: string
  routeTemplate?: string
  chainId?: number
  operationType?: string
  vaultAddress?: string
  assetAddress?: string
  quoteProvider?: string
  reason?: string
  invariant?: string
  count?: number
}

export interface ClientObservabilityPayload extends ClientObservabilityFields {
  source: 'client'
  untrusted: true
  name?: string
  message?: string
  fingerprint: string
  error?: ReturnType<typeof summarizeViemError>
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const ALLOWED_EVENTS = new Set<string>(CLIENT_EVENTS)
const TEXT_FIELDS = ['flow', 'phase', 'routeTemplate', 'operationType', 'quoteProvider', 'reason', 'invariant'] as const
const NUMBER_FIELDS = ['chainId', 'count'] as const
const ERROR_KINDS = new Set<ReturnType<typeof summarizeViemError>['kind']>([
  'rpc-timeout',
  'rpc-http',
  'rpc-rate-limited',
  'rpc-resource-unavailable',
  'rpc-socket-closed',
  'rpc-unreachable',
  'contract-revert',
  'unknown',
])

export function routeTemplate(pathname: string): string {
  return pathname
    .split('/')
    .map(part => ADDRESS_RE.test(part) ? ':address' : /^[0-9]+$/.test(part) ? ':number' : part)
    .join('/')
}

const truncate = (value: string, max: number): string => value.length > max ? value.slice(0, max) : value
const isEvent = (value: unknown): value is ClientObservabilityEvent => typeof value === 'string' && ALLOWED_EVENTS.has(value)
const isAddress = (value: unknown): value is string => typeof value === 'string' && ADDRESS_RE.test(value)
const isErrorKind = (value: unknown): value is ReturnType<typeof summarizeViemError>['kind'] =>
  typeof value === 'string' && ERROR_KINDS.has(value as ReturnType<typeof summarizeViemError>['kind'])

function redactText(value: string): string {
  return value
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[url-redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[jwt-redacted]')
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{8,}\b/g, '[token-redacted]')
    .replace(/Request body:\s*[^,\n]+/gi, 'Request body: [redacted]')
    .replace(/\b0x[a-fA-F0-9]{16,}\b/g, '[hex-redacted]')
}

function cleanString(value: unknown, max = 160): string | undefined {
  return typeof value === 'string' && value.trim() ? truncate(redactText(value.trim()), max) : undefined
}

function stableHash(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function clientPayloadFingerprint(payload: ClientObservabilityPayload): string {
  return stableHash(JSON.stringify({
    event: payload.event,
    flow: payload.flow,
    phase: payload.phase,
    routeTemplate: payload.routeTemplate,
    chainId: payload.chainId,
    name: payload.name,
    message: payload.message,
    kind: payload.error?.kind,
  }))
}

function errorCode(error: unknown): number | string | undefined {
  let current = error
  const seen = new WeakSet<object>()
  for (let i = 0; i < 8 && current && typeof current === 'object'; i++) {
    if (seen.has(current)) return undefined
    seen.add(current)
    const code = (current as { code?: unknown }).code
    if (typeof code === 'number' || typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
}

export function isUserRejectedError(error: unknown): boolean {
  const code = errorCode(error)
  if (code === 4001 || code === '4001' || code === 'ACTION_REJECTED') return true
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /user rejected|user denied|rejected by user|request rejected|user cancelled|user canceled/i.test(message)
}

function isUserRejectedRecord(record: Record<string, unknown>): boolean {
  const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : undefined
  return isUserRejectedError(record.message)
    || isUserRejectedError(error?.message)
    || isUserRejectedError(error?.shortMessage)
    || error?.code === 4001
    || error?.code === '4001'
}

function addAllowlistedFields(payload: ClientObservabilityPayload, source: Record<string, unknown>): void {
  for (const key of TEXT_FIELDS) {
    const value = cleanString(source[key])
    if (value) payload[key] = value
  }
  for (const key of NUMBER_FIELDS) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) payload[key] = value
  }
  if (isAddress(source.vaultAddress)) payload.vaultAddress = source.vaultAddress
  if (isAddress(source.assetAddress)) payload.assetAddress = source.assetAddress
}

function addErrorSummary(payload: ClientObservabilityPayload, error: unknown): void {
  if (error instanceof Error) {
    payload.name = truncate(error.name, 80)
    payload.message = truncate(redactText(error.message), 240)
    const summary = summarizeViemError(error)
    payload.error = {
      ...summary,
      shortMessage: truncate(redactText(summary.shortMessage), 240),
    }
  }
  else {
    const message = cleanString(error, 240)
    if (message) payload.message = message
  }
}

export function normalizeClientObservabilityPayload(
  fields: ClientObservabilityFields,
  error?: unknown,
): ClientObservabilityPayload | null {
  if (!isEvent(fields.event)) return null
  if (fields.event === 'tx_execute_failed' && isUserRejectedError(error)) return null

  const payload: ClientObservabilityPayload = {
    source: 'client',
    untrusted: true,
    event: fields.event,
    fingerprint: '',
  }
  addAllowlistedFields(payload, fields as unknown as Record<string, unknown>)
  addErrorSummary(payload, error)
  payload.fingerprint = clientPayloadFingerprint(payload)

  return payload
}

export function sanitizeClientObservabilityInput(input: unknown): ClientObservabilityPayload | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  if (record.source !== 'client' || !isEvent(record.event) || typeof record.fingerprint !== 'string') return null
  if (record.event === 'tx_execute_failed' && isUserRejectedRecord(record)) return null

  const payload = normalizeClientObservabilityPayload({ event: record.event, ...record } as ClientObservabilityFields)
  if (!payload) return null

  const message = cleanString(record.message, 240)
  const name = cleanString(record.name, 80)
  if (message) payload.message = message
  if (name) payload.name = name

  const error = record.error
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>
    const functionName = cleanString(err.functionName, 80)
    const causeName = cleanString(err.causeName, 80)
    payload.error = {
      kind: isErrorKind(err.kind) ? err.kind : 'unknown',
      name: cleanString(err.name, 80) || 'Error',
      shortMessage: cleanString(err.shortMessage, 240) || '',
      isTransport: typeof err.isTransport === 'boolean' ? err.isTransport : false,
      ...(typeof err.status === 'number' ? { status: err.status } : {}),
      ...(typeof err.code === 'number' ? { code: err.code } : {}),
      ...(functionName ? { functionName } : {}),
      ...(causeName ? { causeName } : {}),
    }
  }

  payload.fingerprint = clientPayloadFingerprint(payload)

  return payload
}

export function shouldSampleClientPayload(payload: ClientObservabilityPayload): boolean {
  return payload.event !== 'tx_execute_failed' || Number.parseInt(payload.fingerprint.slice(0, 2), 16) < 64
}

export async function reportClientEvent(fields: ClientObservabilityFields, error?: unknown): Promise<void> {
  // Production-only by default; set NUXT_PUBLIC_OBSERVABILITY_DEV=true to test
  // the browser-to-/api/internal/client-error path during local development.
  if (!import.meta.client || (import.meta.dev && import.meta.env.NUXT_PUBLIC_OBSERVABILITY_DEV !== 'true')) return
  const payload = normalizeClientObservabilityPayload({
    routeTemplate: routeTemplate(window.location.pathname),
    ...fields,
  }, error)
  if (!payload || !shouldSampleClientPayload(payload)) return

  const key = `client-observability:${payload.fingerprint}`
  const now = Date.now()
  try {
    const last = window.sessionStorage.getItem(key)
    if (last && now - Number(last) < 60_000) return
    window.sessionStorage.setItem(key, String(now))
  }
  catch {
    // sessionStorage can be unavailable in hardened browser contexts.
  }

  const body = JSON.stringify(payload)
  if (navigator.sendBeacon?.('/api/internal/client-error', new Blob([body], { type: 'application/json' }))) return

  await fetch('/api/internal/client-error', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
    keepalive: true,
  }).catch(() => undefined)
}

import { BaseError } from 'viem'

/**
 * Coarse classification of an error encountered during a viem call. Used to
 * route logging (one-line summary vs full detail), suppress per-item retries
 * after a transport failure, and tag log records for downstream filtering.
 */
export type ViemErrorKind
  = | 'rpc-timeout'
    | 'rpc-http'
    | 'rpc-rate-limited'
    | 'rpc-resource-unavailable'
    | 'rpc-socket-closed'
    | 'rpc-unreachable'
    | 'contract-revert'
    | 'unknown'

export type ViemErrorClassification = {
  kind: ViemErrorKind
  name: string
  shortMessage: string
  isTransport: boolean
  url?: string
  status?: number
  code?: number
  functionName?: string
  contractAddress?: string
  causeName?: string
  causeMessage?: string
}

const TRANSPORT_KINDS: ReadonlySet<ViemErrorKind> = new Set([
  'rpc-timeout',
  'rpc-http',
  'rpc-rate-limited',
  'rpc-resource-unavailable',
  'rpc-socket-closed',
  'rpc-unreachable',
])

const KIND_BY_VIEM_NAME: Readonly<Record<string, ViemErrorKind>> = {
  TimeoutError: 'rpc-timeout',
  HttpRequestError: 'rpc-http',
  LimitExceededRpcError: 'rpc-rate-limited',
  ResourceUnavailableRpcError: 'rpc-resource-unavailable',
  WebSocketRequestError: 'rpc-socket-closed',
  SocketClosedError: 'rpc-socket-closed',
  ContractFunctionRevertedError: 'contract-revert',
}

const NETWORK_MESSAGE_PATTERNS: readonly RegExp[] = [
  /HTTP request failed/i,
  /fetch failed/i,
  /ENOTFOUND/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /network is unreachable/i,
]

const REVERT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /reverted/i,
  /Execution reverted/i,
]

const pickViemField = <T>(err: unknown, key: string): T | undefined => {
  if (typeof err !== 'object' || err === null) return undefined
  const value = (err as Record<string, unknown>)[key]
  return value as T | undefined
}

const walkCauses = (err: unknown, max = 8): unknown[] => {
  const out: unknown[] = []
  let current: unknown = err
  while (current != null && out.length < max) {
    out.push(current)
    if (typeof current !== 'object') break
    const next = (current as { cause?: unknown }).cause
    if (next === current) break
    current = next
  }
  return out
}

/**
 * Classify a viem error into a small, log-friendly shape. Walks the cause
 * chain via BaseError.walk() (and a manual fallback for non-viem causes), so
 * a `ContractFunctionExecutionError → CallExecutionError → TimeoutError`
 * stack still reports `kind: 'rpc-timeout'`.
 */
export const classifyViemError = (err: unknown): ViemErrorClassification => {
  const isViem = err instanceof BaseError
  const name = err instanceof Error ? err.name : 'NonError'
  const shortMessage = isViem
    ? err.shortMessage
    : err instanceof Error
      ? err.message
      : String(err)

  let kind: ViemErrorKind = 'unknown'
  let causeName: string | undefined
  let causeMessage: string | undefined

  if (isViem) {
    const root = err.walk()
    if (root instanceof Error) {
      causeName = root.name
      causeMessage = root.message
    }
    if (root instanceof BaseError && KIND_BY_VIEM_NAME[root.name]) {
      kind = KIND_BY_VIEM_NAME[root.name]
    }
    else if (KIND_BY_VIEM_NAME[err.name]) {
      kind = KIND_BY_VIEM_NAME[err.name]
    }
    if (kind === 'unknown') {
      // Surface a wrapped non-BaseError (e.g. fetch's `TypeError: fetch failed`)
      // as an unreachable RPC rather than 'unknown'.
      if (root instanceof Error && !(root instanceof BaseError)) {
        kind = 'rpc-unreachable'
      }
    }
  }
  else {
    // Non-viem error: scan name + message of the cause chain for known signals.
    for (const node of walkCauses(err)) {
      if (!(node instanceof Error)) continue
      if (KIND_BY_VIEM_NAME[node.name]) {
        kind = KIND_BY_VIEM_NAME[node.name]
        causeName ??= node.name
        causeMessage ??= node.message
        break
      }
      if (REVERT_MESSAGE_PATTERNS.some(re => re.test(node.message))) {
        kind = 'contract-revert'
        causeName ??= node.name
        causeMessage ??= node.message
        break
      }
      if (NETWORK_MESSAGE_PATTERNS.some(re => re.test(node.message))) {
        kind = 'rpc-unreachable'
        causeName ??= node.name
        causeMessage ??= node.message
        break
      }
    }
  }

  // Last-chance message scan for viem errors that didn't match by class name.
  if (kind === 'unknown' && /timed out|took too long/i.test(shortMessage)) {
    kind = 'rpc-timeout'
  }
  if (kind === 'unknown' && REVERT_MESSAGE_PATTERNS.some(re => re.test(shortMessage))) {
    kind = 'contract-revert'
  }
  if (kind === 'unknown' && NETWORK_MESSAGE_PATTERNS.some(re => re.test(shortMessage))) {
    kind = 'rpc-unreachable'
  }

  return {
    kind,
    name,
    shortMessage,
    isTransport: TRANSPORT_KINDS.has(kind),
    url: pickViemField<string>(err, 'url'),
    status: pickViemField<number>(err, 'status'),
    code: pickViemField<number>(err, 'code'),
    functionName: pickViemField<string>(err, 'functionName'),
    contractAddress: pickViemField<string>(err, 'contractAddress'),
    causeName,
    causeMessage,
  }
}

/**
 * Compact, log-safe summary of a viem error. Strips noisy fields (`abi`,
 * `metaMessages`, `args`, raw hex request bodies) so a single error never
 * floods stderr / log aggregators with hundreds of lines.
 */
export const summarizeViemError = (err: unknown): ViemErrorClassification & { kind: ViemErrorKind } => classifyViemError(err)

/**
 * True for transport/provider-level failures (HTTP error, network down,
 * timeout, RPC rate-limit). Used by batch callers to suppress per-item
 * retries against an already-broken endpoint.
 */
export const isTransportError = (err: unknown): boolean => classifyViemError(err).isTransport

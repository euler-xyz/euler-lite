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
  // Top-level RpcRequestError is the parent for any JSON-RPC error response;
  // when its specific subclass isn't recognised below we treat it as a
  // (probably transient) transport failure and let the JSON-RPC code fallback
  // refine the kind.
  RpcRequestError: 'rpc-unreachable',
  InternalRpcError: 'rpc-unreachable',
  LimitExceededRpcError: 'rpc-rate-limited',
  ResourceUnavailableRpcError: 'rpc-resource-unavailable',
  ResourceNotFoundRpcError: 'rpc-resource-unavailable',
  WebSocketRequestError: 'rpc-socket-closed',
  SocketClosedError: 'rpc-socket-closed',
  ChainDisconnectedError: 'rpc-socket-closed',
  ProviderDisconnectedError: 'rpc-socket-closed',
  ContractFunctionRevertedError: 'contract-revert',
}

// JSON-RPC standard error codes (https://www.jsonrpc.org/specification#error_object)
// plus EIP-1474 / common provider extensions. A bare `RpcRequestError` whose
// subclass isn't in `KIND_BY_VIEM_NAME` (some upstreams return non-standard
// shapes) gets refined here when the code is recognisable.
const KIND_BY_RPC_CODE: Readonly<Record<number, ViemErrorKind>> = {
  [-32000]: 'rpc-unreachable', // generic server error / "execution reverted" (some clients)
  [-32002]: 'rpc-resource-unavailable',
  [-32005]: 'rpc-rate-limited',
  [-32603]: 'rpc-unreachable', // internal error
  429: 'rpc-rate-limited', // some providers shadow HTTP 429 onto RPC code
  503: 'rpc-unreachable',
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

const TIMEOUT_MESSAGE_PATTERN = /timed out|took too long/i

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

const pickString = (err: unknown, key: string): string | undefined => {
  if (!isPlainObject(err)) return undefined
  const v = err[key]
  return typeof v === 'string' ? v : undefined
}

const pickNumber = (err: unknown, key: string): number | undefined => {
  if (!isPlainObject(err)) return undefined
  const v = err[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Walk a `cause` chain. Uses a `WeakSet` of visited refs so mutual cycles
 * (`a.cause = b; b.cause = a`) terminate after their first node instead of
 * spinning the bounded loop. Non-object `cause` values terminate immediately.
 */
const walkCauses = (err: unknown, max = 8): unknown[] => {
  const out: unknown[] = []
  const visited = new WeakSet<object>()
  let current: unknown = err
  while (current != null && out.length < max) {
    out.push(current)
    if (!isPlainObject(current)) break
    if (visited.has(current)) break
    visited.add(current)
    const next = (current as { cause?: unknown }).cause
    current = next
  }
  return out
}

const classifyByName = (errorName: string): ViemErrorKind | undefined =>
  KIND_BY_VIEM_NAME[errorName]

const classifyByCode = (code: number | undefined): ViemErrorKind | undefined =>
  code != null ? KIND_BY_RPC_CODE[code] : undefined

const classifyByMessage = (msg: string): ViemErrorKind | undefined => {
  if (TIMEOUT_MESSAGE_PATTERN.test(msg)) return 'rpc-timeout'
  if (REVERT_MESSAGE_PATTERNS.some(re => re.test(msg))) return 'contract-revert'
  if (NETWORK_MESSAGE_PATTERNS.some(re => re.test(msg))) return 'rpc-unreachable'
  return undefined
}

/**
 * Classify a viem error into a small, log-friendly shape. Walks the cause
 * chain via `BaseError.walk()` for viem errors and a manual cause walk for
 * everything else, so a wrapped
 * `ContractFunctionExecutionError → CallExecutionError → TimeoutError`
 * stack still reports `kind: 'rpc-timeout'`. Resolution order:
 *
 *   1. Walk the cause chain — first node whose class name is in
 *      `KIND_BY_VIEM_NAME` wins.
 *   2. Otherwise, JSON-RPC `code` on any node (handles `RpcRequestError`
 *      subclasses that ship a code but a non-canonical `name`).
 *   3. Otherwise, message-pattern scan against every cause-chain node
 *      (timeout / revert / network keywords) — covers fetch's
 *      `TypeError: fetch failed` and similar non-Error throwables.
 *   4. Otherwise `kind: 'unknown'`.
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

  // Build the chain of nodes once. For viem errors we also use `BaseError.walk()`
  // so the deepest viem cause is preferred (it carries the most specific name).
  const chain = walkCauses(err)
  const root = isViem ? err.walk() : undefined
  if (root instanceof Error && !chain.includes(root)) {
    chain.push(root)
  }

  // 1. Class-name lookup, outermost first. Viem's specific subclasses
  //    (`LimitExceededRpcError`, `ResourceUnavailableRpcError`, …) are wrappers
  //    around the generic `RpcRequestError`, so the wrapper carries the more
  //    specific kind — walking deepest-first would incorrectly collapse a rate
  //    limit to a generic `rpc-unreachable`. Generic wrappers like
  //    `ContractFunctionExecutionError` aren't in the table, so they're
  //    skipped and the inner `TimeoutError` still wins.
  for (const node of chain) {
    if (!(node instanceof Error)) continue
    const matched = classifyByName(node.name)
    if (matched) {
      kind = matched
      causeName ??= node.name
      causeMessage ??= node.message
      break
    }
  }

  // 2. JSON-RPC code fallback.
  if (kind === 'unknown') {
    for (const node of chain) {
      const matched = classifyByCode(pickNumber(node, 'code'))
      if (matched) {
        kind = matched
        if (node instanceof Error) {
          causeName ??= node.name
          causeMessage ??= node.message
        }
        break
      }
    }
  }

  // 3. Message-pattern scan, walking the chain not just the outer.
  if (kind === 'unknown') {
    for (const node of chain) {
      const message = node instanceof Error ? node.message : ''
      const matched = classifyByMessage(message)
      if (matched) {
        kind = matched
        if (node instanceof Error) {
          causeName ??= node.name
          causeMessage ??= node.message
        }
        break
      }
    }
    // Outer shortMessage as final fallback (viem wrappers often carry richer
    // text in shortMessage than in any individual cause's `message`).
    if (kind === 'unknown') {
      const matched = classifyByMessage(shortMessage)
      if (matched) kind = matched
    }
  }

  return {
    kind,
    name,
    shortMessage,
    isTransport: TRANSPORT_KINDS.has(kind),
    url: pickString(err, 'url'),
    status: pickNumber(err, 'status'),
    code: pickNumber(err, 'code'),
    functionName: pickString(err, 'functionName'),
    contractAddress: pickString(err, 'contractAddress'),
    causeName,
    causeMessage,
  }
}

/**
 * Compact, log-safe summary of a viem error. Strips noisy fields (`abi`,
 * `metaMessages`, `args`, raw hex request bodies) so a single error never
 * floods stderr / log aggregators with hundreds of lines.
 *
 * Currently identical to `classifyViemError` because the classification
 * shape is already strictly log-safe — intentionally aliased so callers
 * communicate intent (`summarize` for log payloads, `classify` for kind
 * checks). If `ViemErrorClassification` ever gains fields that are unsafe
 * to log (e.g. a raw `request` blob), narrow the projection here.
 */
export const summarizeViemError: (err: unknown) => ViemErrorClassification = classifyViemError

/**
 * True for transport/provider-level failures (HTTP error, network down,
 * timeout, RPC rate-limit). Used by batch callers to suppress per-item
 * retries against an already-broken endpoint.
 */
export const isTransportError = (err: unknown): boolean => classifyViemError(err).isTransport

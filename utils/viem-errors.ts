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
  InternalRpcError: 'rpc-unreachable',
  LimitExceededRpcError: 'rpc-rate-limited',
  ResourceUnavailableRpcError: 'rpc-resource-unavailable',
  ResourceNotFoundRpcError: 'rpc-resource-unavailable',
  WebSocketRequestError: 'rpc-socket-closed',
  SocketClosedError: 'rpc-socket-closed',
  ChainDisconnectedError: 'rpc-socket-closed',
  ProviderDisconnectedError: 'rpc-socket-closed',
  ExecutionRevertedError: 'contract-revert',
  ContractFunctionRevertedError: 'contract-revert',
}

const GENERIC_RPC_ERROR_NAMES: ReadonlySet<string> = new Set([
  'RpcRequestError',
])

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

/**
 * Walk the cause chain for the first node carrying a string at `key`. Viem
 * stores diagnostic info (`url`, `functionName`, `contractAddress`) on the
 * specific error class that originated it — the wrapper at the top of the
 * chain doesn't carry them, so the outer-only pick returned undefined for
 * any wrapped error.
 */
const pickStringFromChain = (chain: readonly unknown[], key: string): string | undefined => {
  for (const node of chain) {
    const v = pickString(node, key)
    if (v != null) return v
  }
  return undefined
}

const pickNumberFromChain = (chain: readonly unknown[], key: string): number | undefined => {
  for (const node of chain) {
    const v = pickNumber(node, key)
    if (v != null) return v
  }
  return undefined
}

/**
 * RPC provider URLs (Chainstack, Alchemy, Infura, …) commonly carry the API
 * key as a path segment or query parameter. Logging them verbatim would ship
 * those keys to BetterStack as a queryable JSON field. Reduce to host only —
 * we keep enough to know which provider was unreachable, nothing more.
 */
const redactUrl = (url: string | undefined): string | undefined => {
  if (url == null) return undefined
  try {
    return new URL(url).host
  }
  catch {
    // Not a parseable URL — drop entirely rather than risk leaking what's there.
    return undefined
  }
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

const messageCandidates = (node: unknown): string[] => {
  if (!isPlainObject(node)) {
    return node instanceof Error ? [node.message] : []
  }
  return [
    node instanceof Error ? node.message : undefined,
    pickString(node, 'shortMessage'),
    pickString(node, 'details'),
    pickString(node, 'message'),
  ].filter((v): v is string => typeof v === 'string' && v.length > 0)
}

const classifyRevertByMessage = (messages: readonly string[]): ViemErrorKind | undefined =>
  messages.some(msg => REVERT_MESSAGE_PATTERNS.some(re => re.test(msg))) ? 'contract-revert' : undefined

/**
 * Classify a viem error into a small, log-friendly shape. Walks the cause
 * chain via `BaseError.walk()` for viem errors and a manual cause walk for
 * everything else, so a wrapped
 * `ContractFunctionExecutionError → CallExecutionError → TimeoutError`
 * stack still reports `kind: 'rpc-timeout'`. Resolution order:
 *
 *   1. Walk the cause chain — first node whose class name is in
 *      `KIND_BY_VIEM_NAME` wins.
 *   2. Otherwise, explicit revert messages on generic RPC/call wrappers win
 *      before JSON-RPC code fallback. Some HyperEVM RPCs report
 *      "Execution reverted" as a bare `RpcRequestError` with code -32000.
 *   3. Otherwise, JSON-RPC `code` on any node (handles `RpcRequestError`
 *      subclasses that ship a code but a non-canonical `name`).
 *   4. Otherwise, generic `RpcRequestError` nodes become `rpc-unreachable`
 *      after code refinement has had a chance to produce a more specific kind.
 *   5. Otherwise, message-pattern scan against every cause-chain node
 *      (timeout / revert / network keywords) — covers fetch's
 *      `TypeError: fetch failed` and similar non-Error throwables.
 *   6. Otherwise `kind: 'unknown'`.
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
      break
    }
  }

  // 2. Revert messages on generic viem RPC/call wrappers are on-chain
  //    failures, even when the JSON-RPC code is the ambiguous -32000.
  if (kind === 'unknown') {
    for (const node of chain) {
      const matched = classifyRevertByMessage(messageCandidates(node))
      if (matched) {
        kind = matched
        if (node instanceof Error) causeName ??= node.name
        break
      }
    }
    if (kind === 'unknown') {
      const matched = classifyRevertByMessage([shortMessage])
      if (matched) kind = matched
    }
  }

  // 3. JSON-RPC code fallback.
  if (kind === 'unknown') {
    for (const node of chain) {
      const matched = classifyByCode(pickNumber(node, 'code'))
      if (matched) {
        kind = matched
        if (node instanceof Error) causeName ??= node.name
        break
      }
    }
  }

  // 4. Generic JSON-RPC wrappers are still transport failures, but only after
  //    the code fallback gets the first shot at classifying rate limits etc.
  if (kind === 'unknown') {
    for (const node of chain) {
      if (!(node instanceof Error)) continue
      if (GENERIC_RPC_ERROR_NAMES.has(node.name)) {
        kind = 'rpc-unreachable'
        causeName ??= node.name
        break
      }
    }
  }

  // 5. Message-pattern scan, walking the chain not just the outer.
  if (kind === 'unknown') {
    for (const node of chain) {
      const matched = messageCandidates(node)
        .map(classifyByMessage)
        .find((value): value is ViemErrorKind => value != null)
      if (matched) {
        kind = matched
        if (node instanceof Error) causeName ??= node.name
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
    url: redactUrl(pickStringFromChain(chain, 'url')),
    status: pickNumberFromChain(chain, 'status'),
    code: pickNumberFromChain(chain, 'code'),
    functionName: pickStringFromChain(chain, 'functionName'),
    contractAddress: pickStringFromChain(chain, 'contractAddress'),
    causeName,
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

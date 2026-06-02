const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/

const FUUL_INCENTIVE_PROTOCOLS = new Set(['euler', 'euler-looping'])
const MERKL_OPPORTUNITY_TYPES = new Set([
  'EULER',
  'MULTILENDBORROW',
  'ERC20LOGPROCESSOR',
  'EULER_BORROW_FROM_COLLATERAL',
  'EULER_MULTI_BORROW_FROM_COLLATERAL',
])
const MERKL_PROTOCOL_SCOPED_TYPES = new Set([
  'ERC20LOGPROCESSOR',
  'EULER_BORROW_FROM_COLLATERAL',
  'EULER_MULTI_BORROW_FROM_COLLATERAL',
])

type JsonRecord = Record<string, unknown>

const normalizePath = (path: string): string =>
  path.replace(/^\/+/, '').replace(/\/+$/, '')

const hasNoSearchParams = (params: URLSearchParams): boolean => {
  for (const _key of params.keys()) return false
  return true
}

const hasOnlySearchKeys = (params: URLSearchParams, allowed: readonly string[]): boolean => {
  const allowedSet = new Set(allowed)
  for (const key of params.keys()) {
    if (!allowedSet.has(key)) return false
  }
  return true
}

const getSingleParam = (params: URLSearchParams, key: string): string | undefined => {
  const values = params.getAll(key)
  return values.length === 1 ? values[0] : undefined
}

const hasPositiveChainId = (params: URLSearchParams): boolean =>
  POSITIVE_INTEGER_RE.test(getSingleParam(params, 'chainId') ?? '')

const hasOnlyObjectKeys = (record: JsonRecord, allowed: readonly string[]): boolean => {
  const allowedSet = new Set(allowed)
  return Object.keys(record).every(key => allowedSet.has(key))
}

const isPlainJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isAllowedFuulProxyRequest = (
  method: string,
  path: string,
  params: URLSearchParams,
): boolean => {
  const normalizedMethod = method.toUpperCase()
  const normalizedPath = normalizePath(path)

  if (normalizedPath === 'incentives') {
    if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return false
    if (!hasOnlySearchKeys(params, ['protocol', 'chain_id'])) return false
    const protocol = getSingleParam(params, 'protocol')
    const chainId = getSingleParam(params, 'chain_id')
    return Boolean(protocol && FUUL_INCENTIVE_PROTOCOLS.has(protocol) && POSITIVE_INTEGER_RE.test(chainId ?? ''))
  }

  if (normalizedPath === 'totals') {
    if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return false
    if (!hasOnlySearchKeys(params, ['user_identifier', 'user_identifier_type'])) return false
    return getSingleParam(params, 'user_identifier_type') === 'evm_address'
      && EVM_ADDRESS_RE.test(getSingleParam(params, 'user_identifier') ?? '')
  }

  if (normalizedPath === 'claim-checks') {
    return normalizedMethod === 'POST' && hasNoSearchParams(params)
  }

  return false
}

export const isAllowedFuulClaimChecksBody = (body: string | undefined): boolean => {
  if (!body) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  }
  catch {
    return false
  }
  if (!isPlainJsonRecord(parsed)) return false
  if (!hasOnlyObjectKeys(parsed, ['userIdentifier', 'userIdentifierType'])) return false
  return parsed.userIdentifierType === 'evm_address'
    && typeof parsed.userIdentifier === 'string'
    && EVM_ADDRESS_RE.test(parsed.userIdentifier)
}

export const isAllowedIncentraProxyRequest = (
  method: string,
  path: string,
  params: URLSearchParams,
): boolean => {
  if (method.toUpperCase() !== 'POST' || !hasNoSearchParams(params)) return false
  const normalizedPath = normalizePath(path)
  return normalizedPath === 'sdk/v1/eulerCampaigns'
    || normalizedPath === 'v1/getMerkleProofsBatch'
}

export const isAllowedMerklProxyRequest = (
  method: string,
  path: string,
  params: URLSearchParams,
): boolean => {
  const normalizedMethod = method.toUpperCase()
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return false

  const normalizedPath = normalizePath(path)
  if (normalizedPath === 'opportunities') {
    if (!hasOnlySearchKeys(params, ['chainId', 'type', 'campaigns', 'mainProtocolId'])) return false
    const type = getSingleParam(params, 'type')
    if (!type || !MERKL_OPPORTUNITY_TYPES.has(type)) return false
    if (!hasPositiveChainId(params) || getSingleParam(params, 'campaigns') !== 'true') return false

    if (MERKL_PROTOCOL_SCOPED_TYPES.has(type)) {
      return getSingleParam(params, 'mainProtocolId') === 'euler'
    }
    return !params.has('mainProtocolId')
  }

  const userRewardsMatch = normalizedPath.match(/^users\/(0x[a-fA-F0-9]{40})\/rewards$/)
  if (userRewardsMatch) {
    if (!hasOnlySearchKeys(params, ['chainId', 'type'])) return false
    if (!hasPositiveChainId(params)) return false
    const type = getSingleParam(params, 'type')
    return type === undefined || type === 'TOKEN'
  }

  return false
}

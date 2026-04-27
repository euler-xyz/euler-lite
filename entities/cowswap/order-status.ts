import type {
  CowSwapCompetitionOrderStatusType,
  CowSwapLifecycleOrderStatusType,
  CowSwapOrderStatus,
  CowSwapOrderStatusType,
  CowSwapOrderUid,
  CowSwapTerminalOrderStatus,
} from './types'

const COMPETITION_STATUS_TYPES = new Set<CowSwapCompetitionOrderStatusType>([
  'open', 'scheduled', 'active', 'solved', 'executing', 'traded', 'cancelled',
])

const ORDER_STATUS_TYPES = new Set<CowSwapLifecycleOrderStatusType>([
  'presignaturePending', 'open', 'fulfilled', 'cancelled', 'expired',
])

const TERMINAL_STATUS_TYPES = new Set<CowSwapTerminalOrderStatus>([
  'traded', 'fulfilled', 'cancelled', 'expired',
])

const normalizeCompetitionStatus = (type: unknown): CowSwapCompetitionOrderStatusType | undefined => {
  if (typeof type !== 'string') return undefined
  return COMPETITION_STATUS_TYPES.has(type as CowSwapCompetitionOrderStatusType)
    ? type as CowSwapCompetitionOrderStatusType
    : undefined
}

const normalizeOrderStatus = (status: unknown): CowSwapLifecycleOrderStatusType | undefined => {
  if (typeof status !== 'string') return undefined
  return ORDER_STATUS_TYPES.has(status as CowSwapLifecycleOrderStatusType)
    ? status as CowSwapLifecycleOrderStatusType
    : undefined
}

export const resolveCowSwapOrderStatusType = (params: {
  competitionType?: CowSwapCompetitionOrderStatusType
  orderType?: CowSwapLifecycleOrderStatusType
}): CowSwapOrderStatusType => {
  // Terminal statuses from either source take priority
  if (params.competitionType === 'traded') return 'traded'
  if (params.orderType === 'fulfilled') return 'fulfilled'
  if (params.orderType === 'cancelled') return 'cancelled'
  if (params.orderType === 'expired') return 'expired'
  if (params.competitionType === 'cancelled') return 'cancelled'
  // Non-terminal competition statuses (active, solved, executing) are transient —
  // solvers reconsider orders every auction round, so 'active' doesn't mean
  // the order will be filled. Prefer the lifecycle status for display.
  if (params.orderType) return params.orderType
  if (params.competitionType) return params.competitionType
  return 'unknown'
}

export const isCowSwapTerminalStatus = (
  type?: CowSwapOrderStatusType,
): type is CowSwapTerminalOrderStatus => {
  if (!type) return false
  return TERMINAL_STATUS_TYPES.has(type as CowSwapTerminalOrderStatus)
}

const fetchJson = async <T>(url: string, signal?: AbortSignal): Promise<{ data?: T, error?: Error }> => {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`CoW API ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = await res.json() as T
    return { data }
  }
  catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
}

export const fetchCowSwapOrderStatus = async (
  orderUid: CowSwapOrderUid,
  orderbookUrl: string,
  signal?: AbortSignal,
): Promise<CowSwapOrderStatus> => {
  const [competitionResult, orderResult] = await Promise.all([
    fetchJson<{ type?: unknown }>(`${orderbookUrl}/api/v1/orders/${orderUid}/status`, signal),
    fetchJson<{ status?: unknown }>(`${orderbookUrl}/api/v1/orders/${orderUid}`, signal),
  ])

  if (!competitionResult.data && !orderResult.data) {
    throw new Error(`Failed to fetch order status for ${orderUid}`)
  }

  const competitionType = normalizeCompetitionStatus(competitionResult.data?.type)
  const orderType = normalizeOrderStatus(orderResult.data?.status)
  const type = resolveCowSwapOrderStatusType({ competitionType, orderType })

  return {
    type,
    competitionType,
    orderType,
    terminal: isCowSwapTerminalStatus(type),
  }
}

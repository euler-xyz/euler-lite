import {
  type ActivityItem,
  type DemoState,
  type FundingSource,
  type LenderPosition,
  type ProtocolHealth,
  type RedemptionRequest,
  type RedemptionStatus,
  type ZipDemoReader,
  demoConfig,
  fallbackRedemptionRequest,
  fundingSources,
  initialDemoState,
  protocolHealth,
} from '~/types/zipcode'

// Reactive demo store for the Zip Code lender demo. All state transitions are
// deterministic and mocked (spec §14–15). State is held in a single Nuxt
// `useState` entry so it survives navigation between pages (which are not
// kept-alive) and is shared by every caller of `useZipDemo()`.
//
// Reads are exposed through a `ZipDemoReader` so a future on-chain adapter can
// be swapped in without touching pages/components (plan "adapter" note).

const STATE_KEY = 'zip-demo-state'

const clone = (state: DemoState): DemoState => structuredClone(state)

const wait = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms)
})

export const useZipDemo = () => {
  const state = useState<DemoState>(STATE_KEY, () => clone(initialDemoState))

  const getActiveRedemptionRequest = (): RedemptionRequest =>
    state.value.redemptionRequests[0] ?? { ...fallbackRedemptionRequest }

  // --- Reader (mock) --------------------------------------------------------
  const reader: ZipDemoReader = {
    getProtocolHealth: () => protocolHealth,
    getPosition: () => state.value.position,
    getActiveRedemptionRequest,
    getActivity: () => state.value.activity,
    getFundingSources: () => fundingSources,
  }

  // --- Reactive reads -------------------------------------------------------
  const position = computed<LenderPosition>(() => reader.getPosition())
  const health = computed<ProtocolHealth>(() => reader.getProtocolHealth())
  const sources = computed<FundingSource[]>(() => reader.getFundingSources())
  const activity = computed<ActivityItem[]>(() => reader.getActivity())
  const activeRedemptionRequest = computed<RedemptionRequest>(() => {
    // Touch the dependency so the computed re-evaluates on mutation.
    void state.value.redemptionRequests
    return getActiveRedemptionRequest()
  })
  const lastDepositZipUsd = computed(() => state.value.lastDepositZipUsd)
  const claimSuccessUsdc = computed(() => state.value.claimSuccessUsdc)
  const hasRedemptionRequest = computed(() => state.value.redemptionRequests.length > 0)

  // --- Actions (deterministic, mocked) -------------------------------------

  /** Deposit USDC and mint zipUSD 1:1 (spec §10.2, §15). Awaits a mocked delay. */
  const deposit = async (amountUsd: number, _fundingSourceId?: string) => {
    await wait(demoConfig.depositProcessingDelayMs)
    const createdAt = '2026-06-04T09:00:00Z'
    const p = state.value.position
    state.value = {
      ...state.value,
      position: {
        totalDepositedUsd: p.totalDepositedUsd + amountUsd,
        portfolioValueUsd: p.portfolioValueUsd + amountUsd,
        zipUsdBalance: p.zipUsdBalance + amountUsd,
        digitalDollarBalanceUsd: p.digitalDollarBalanceUsd - amountUsd,
      },
      lastDepositZipUsd: amountUsd,
      activity: [
        {
          id: `mint-zipusd-${state.value.activity.length + 1}`,
          createdAt,
          type: 'mint-zipusd',
          label: 'Received zipUSD',
          amountZipUsd: amountUsd,
          status: 'complete',
        },
        {
          id: `deposit-usdc-${state.value.activity.length + 2}`,
          createdAt,
          type: 'deposit-usdc',
          label: 'Deposited USDC',
          amountUsd,
          amountUsdc: amountUsd,
          status: 'complete',
        },
        ...state.value.activity,
      ],
    }
  }

  /** Queue a zipUSD redemption request into the current epoch (spec §10.4, §15). */
  const requestRedemption = (zipUsdRequested: number) => {
    const request: RedemptionRequest = {
      id: 'redeem-001',
      zipUsdRequested,
      usdcClaimable: 0,
      zipUsdCarriedForward: 0,
      epochStart: demoConfig.epochStart,
      epochEnd: demoConfig.epochEnd,
      status: 'queued',
    }
    const p = state.value.position
    state.value = {
      ...state.value,
      position: {
        ...p,
        zipUsdBalance: Math.max(0, p.zipUsdBalance - zipUsdRequested),
        portfolioValueUsd: Math.max(0, p.portfolioValueUsd - zipUsdRequested),
      },
      redemptionRequests: [request],
      activity: [
        {
          id: 'redemption-request-001',
          createdAt: '2026-06-04T10:00:00Z',
          type: 'redemption-request',
          label: 'Redemption requested',
          amountZipUsd: zipUsdRequested,
          status: 'pending',
        },
        ...state.value.activity,
      ],
    }
  }

  /** Dev toolbar: force the active request into a demo status (spec §5.4, §10.5). */
  const setRedemptionDemoStatus = (status: RedemptionStatus) => {
    const request = getActiveRedemptionRequest()
    const next: RedemptionRequest = {
      ...request,
      status,
      usdcClaimable:
        status === 'partially-settled'
          ? demoConfig.partialClaimableUsdc
          : status === 'claimable'
            ? request.zipUsdRequested
            : 0,
      zipUsdCarriedForward:
        status === 'partially-settled' ? demoConfig.partialCarriedForwardZipUsd : 0,
    }
    state.value = { ...state.value, redemptionRequests: [next] }
  }

  /** Claim settled USDC (spec §10.6). Awaits a short mocked delay. */
  const claim = async (): Promise<{ usdc: number }> => {
    await wait(demoConfig.depositProcessingDelayMs)
    const request = getActiveRedemptionRequest()
    const claimable = request.usdcClaimable
    state.value = {
      ...state.value,
      claimSuccessUsdc: claimable,
      redemptionRequests: [{ ...request, status: 'claimed', usdcClaimable: 0 }],
      activity: [
        {
          id: 'claim-usdc-001',
          createdAt: '2026-06-04T11:00:00Z',
          type: 'claim-usdc',
          label: 'Claimed USDC',
          amountUsd: claimable,
          amountUsdc: claimable,
          status: 'complete',
        },
        {
          id: 'redemption-settlement-001',
          createdAt: '2026-06-04T10:30:00Z',
          type: 'redemption-settlement',
          label: 'Redemption settled',
          amountUsdc: claimable,
          status: 'complete',
        },
        ...state.value.activity.map(item =>
          item.type === 'redemption-request'
            ? { ...item, status: 'complete' as const }
            : item,
        ),
      ],
    }
    return { usdc: claimable }
  }

  /** Extension hook (KYB approval) — unused in the core lender flow. */
  const approveKyb = () => {
    state.value = { ...state.value, kybStatus: 'approved' }
  }

  const reset = () => {
    state.value = clone(initialDemoState)
  }

  return {
    // reads
    state: computed(() => state.value),
    position,
    protocolHealth: health,
    fundingSources: sources,
    activity,
    activeRedemptionRequest,
    hasRedemptionRequest,
    lastDepositZipUsd,
    claimSuccessUsdc,
    // actions
    deposit,
    requestRedemption,
    setRedemptionDemoStatus,
    claim,
    approveKyb,
    reset,
  }
}

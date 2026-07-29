import type { ActivityEvent, LiquidationRecord } from '@eulerxyz/euler-v2-sdk'
import {
  computed,
  onScopeDispose,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from 'vue'
import { logWarn } from '~/utils/errorHandling'

/** Bounded offset pages fetched per vault window — beyond this, the affected
 *  rows simply stay unenriched. */
const MAX_LIQUIDATION_PAGES = 3
const LIQUIDATION_PAGE_LIMIT = 100

interface UseActivityLiquidationDetailsOptions {
  events: MaybeRefOrGetter<readonly ActivityEvent[]>
  enabled?: MaybeRefOrGetter<boolean>
}

interface LiquidationFetchGroup {
  key: string
  chainId: number
  vault: string
  from: number
  to: number
}

const eventUnixTimestamp = (event: ActivityEvent): number | undefined => {
  const parsed = Math.floor(Date.parse(event.timestamp) / 1_000)
  return Number.isFinite(parsed) ? parsed : undefined
}

const readEventString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined

/**
 * A liquidation event and its `/v3/liquidations` record describe the same
 * on-chain occurrence; there is no shared log index, so the join key is the
 * full identifying tuple. Amounts disambiguate multiple liquidations of the
 * same position inside one transaction.
 */
const liquidationEventJoinKey = (event: ActivityEvent): string | undefined => {
  if (event.type !== 'liquidation' || !event.vault) return undefined
  const violator = readEventString(event.payload?.violator) ?? event.account
  const collateral = readEventString(event.payload?.collateral)
    ?? event.assets?.find(asset => asset.kind === 'collateral')?.address
  const repayAssets = readEventString(event.payload?.repay_assets)
    ?? event.assets?.find(asset => asset.kind === 'assets')?.amountRaw
  if (!violator || !collateral || repayAssets === undefined) return undefined
  return [
    event.chainId,
    event.txHash,
    event.vault,
    violator,
    collateral,
    repayAssets,
  ].join(':').toLowerCase()
}

const liquidationRecordJoinKey = (record: LiquidationRecord): string => [
  record.chainId,
  record.txHash,
  record.vault,
  record.violator,
  record.collateral,
  record.repayAssets,
].join(':').toLowerCase()

/**
 * Enriches displayed liquidation events with historical valuations from the
 * standalone `/v3/liquidations` endpoint (event-time USD amounts, seized
 * collateral converted to underlying units, and the liquidator bonus).
 *
 * Fail-soft by design: rows without a matching record render exactly as they
 * do today, so an unavailable endpoint never degrades the feed itself.
 */
export const useActivityLiquidationDetails = ({
  events,
  enabled = true,
}: UseActivityLiquidationDetailsOptions) => {
  const recordsByJoinKey = new Map<string, LiquidationRecord>()
  const recordsVersion = ref(0)
  /** Windows already fetched (or being fetched) per chain+vault group. */
  const coveredWindows = new Map<string, { from: number, to: number }>()
  let disposed = false

  const liquidationEvents = computed(() =>
    toValue(events).filter(event => event.type === 'liquidation' && event.vault))

  const fetchGroups = computed<LiquidationFetchGroup[]>(() => {
    const groups = new Map<string, LiquidationFetchGroup>()
    for (const event of liquidationEvents.value) {
      const timestamp = eventUnixTimestamp(event)
      if (!event.vault || timestamp === undefined) continue
      const key = `${event.chainId}:${event.vault.toLowerCase()}`
      const group = groups.get(key)
      if (!group) {
        // ±1s pads Date.parse truncation on both window edges.
        groups.set(key, {
          key,
          chainId: event.chainId,
          vault: event.vault,
          from: timestamp - 1,
          to: timestamp + 1,
        })
      }
      else {
        group.from = Math.min(group.from, timestamp - 1)
        group.to = Math.max(group.to, timestamp + 1)
      }
    }
    return [...groups.values()]
  })

  const fetchGroup = async (group: LiquidationFetchGroup) => {
    const covered = coveredWindows.get(group.key)
    if (covered && covered.from <= group.from && covered.to >= group.to) return
    // Claim the widened window up front so concurrent triggers do not refetch;
    // on failure the claim is rolled back and the next window change retries.
    const claimed = {
      from: Math.min(group.from, covered?.from ?? group.from),
      to: Math.max(group.to, covered?.to ?? group.to),
    }
    coveredWindows.set(group.key, claimed)

    try {
      const { getEulerSdkForChain } = useEulerSdk()
      const sdk = await getEulerSdkForChain(group.chainId)
      for (let page = 0; page < MAX_LIQUIDATION_PAGES; page++) {
        const result = await sdk.activityService.fetchLiquidations({
          chainId: group.chainId,
          vault: group.vault as `0x${string}`,
          from: claimed.from,
          to: claimed.to,
          limit: LIQUIDATION_PAGE_LIMIT,
          offset: page * LIQUIDATION_PAGE_LIMIT,
        })
        if (disposed) return
        for (const record of result.data) {
          recordsByJoinKey.set(liquidationRecordJoinKey(record), record)
        }
        if (result.data.length) recordsVersion.value++
        if (result.meta.offset + result.data.length >= result.meta.total) break
      }
    }
    catch (err) {
      if (covered) coveredWindows.set(group.key, covered)
      else coveredWindows.delete(group.key)
      logWarn('useActivityLiquidationDetails/fetchGroup', err)
    }
  }

  watch(
    [fetchGroups, () => Boolean(toValue(enabled))],
    ([groups, isEnabled]) => {
      if (!isEnabled) return
      for (const group of groups) void fetchGroup(group)
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    disposed = true
  })

  const getLiquidationDetails = (event: ActivityEvent): LiquidationRecord | undefined => {
    // Re-resolve as records arrive.
    void recordsVersion.value
    const key = liquidationEventJoinKey(event)
    return key === undefined ? undefined : recordsByJoinKey.get(key)
  }

  return { getLiquidationDetails }
}

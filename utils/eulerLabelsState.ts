import type { EulerLabelEntity, EulerLabelProduct, EulerLabelPointReward } from '~/entities/euler/labels'
import type { OracleAdapterMeta } from '~/entities/oracle'

export const isLoading = ref(false)
export const isReady = ref(false)

// Use a simple object to track loaded state (survives HMR better than ref)
export const loadState = { chainId: null as number | null, timestamp: 0 }

export const products = shallowReactive<Record<string, EulerLabelProduct>>({})
export const entities = shallowReactive<Record<string, EulerLabelEntity>>({})
export const points = shallowReactive<Record<string, EulerLabelPointReward[]>>({})
export const earnVaults: Ref<string[]> = ref([]) // string of earn vault addresses
export const earnVaultBlocks = shallowReactive<Record<string, string[]>>({}) // address (lowercase) -> blocked country codes
export const earnVaultRestrictions = shallowReactive<Record<string, string[]>>({}) // address (lowercase) -> restricted country codes
export const assetBlocks = shallowReactive<Record<string, string[]>>({}) // asset address (lowercase) -> blocked country codes
export const assetRestrictions = shallowReactive<Record<string, string[]>>({}) // asset address (lowercase) -> restricted country codes

/**
 * Compiled pattern rule derived from `EulerLabelAssetEntry` pattern fields.
 * `symbolsLower` / `namesLower` are pre-lowercased sets; regex fields are
 * pre-compiled with the `i` flag. Match is OR across populated fields.
 */
export type CompiledPatternRule = {
  symbolsLower?: Set<string>
  symbolRegex?: RegExp
  namesLower?: Set<string>
  nameRegex?: RegExp
  block?: string[]
  restricted?: string[]
}
export const assetPatternRules = shallowReactive<CompiledPatternRule[]>([])
export const featuredEarnVaults: Set<string> = shallowReactive(new Set())
export const deprecatedEarnVaults = shallowReactive<Record<string, string>>({}) // address (lowercase) -> deprecation reason
export const earnVaultDescriptions = shallowReactive<Record<string, string>>({}) // address (lowercase) -> description
export const earnVaultNotices = shallowReactive<Record<string, string>>({}) // address (lowercase) -> notice
export const notExplorableEarnVaults: Set<string> = shallowReactive(new Set())
// Derived from products - all unique vault addresses across all products
export const verifiedVaultAddresses: Ref<string[]> = ref([])
export const oracleAdapters = shallowReactive<Record<string, OracleAdapterMeta>>({})

export const loadingAdapters = new Set<string>()

// Per-chain bulk-load state for the oracle-adapters all.json fetch.
// loadedAt tracks when we last loaded the bulk payload per chain so we can
// time-bound staleness. pendingBulkLoads holds in-flight promises so
// concurrent callers share a request.
export const bulkLoadedAdapterChains = new Map<number, number>()
export const pendingBulkAdapterLoads = new Map<number, Promise<void>>()

// Wrapper-asset address (lowercase) -> underlying ERC-4626 asset() address (lowercase).
// Populated after labels finish loading by probing soft-restricted vault assets
// via a single multicall. Lifetime is tied to the labels reload cycle: cleared
// on labels reload and repopulated when vaults are ready. Used by `isWrapPair`
// to bypass soft-restrict on the output side of a flow when the counterpart
// is the underlying — wrapping existing exposure is a technical conversion,
// not a new acquisition.
export const wrapPairs = shallowReactive<Record<string, string>>({})

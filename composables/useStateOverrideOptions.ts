import { type Address, getAddress } from 'viem'
import { fetchErc20SlotHints, type SlotHints, type SimulationStateOverrideOptions } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdkForChain } from '~/composables/useEulerSdk'
import { logWarn } from '~/utils/errorHandling'

const pendingStateOverrideHintResolutions = ref(0)

export const useStateOverrideResolution = () => ({
  isResolvingStateOverrideHints: computed(() => pendingStateOverrideHintResolutions.value > 0),
})

/**
 * Builds `SimulationStateOverrideOptions` to pass into the SDK's
 * `simulateTransactionPlan` / `estimateGasForTransactionPlan` / `prepareTransactionPlan`
 * paths.
 *
 * The motivation is to cut the number of RPCs the SDK's state-override
 * derivation has to make. Specifically:
 *
 *  - **`wallet.balances`** — the form already knows what the user holds via
 *    `useWallets`. Feed that map through and the SDK skips per-call `balanceOf`
 *    when the snapshot already proves the user holds enough.
 *  - **`noBalanceOverride: true`** — forms validate "Not enough balance" up
 *    front before allowing submit/quotes. The simulator doesn't need to forge
 *    balances; the SDK can skip the entire balance branch.
 *  - **`slotHints`** — pre-fetched ERC20 storage-slot indices, owner-
 *    -agnostic, computed cryptographically. Lets the SDK bypass
 *    `eth_createAccessList` discovery for the common case. We fire this once
 *    per token and reuse forever (slot indices are immutable).
 *
 * The composable exposes:
 *  - `buildStateOverrideOptions({ tokens, noBalanceOverride })` — assembles the
 *    options object for the next call.
 *  - `primeSlotHintsFor(tokens)` — fires the slot probes in the background as
 *    soon as the form knows which assets matter. The cache is module-scope so
 *    later calls reuse without re-probing.
 */
export const useStateOverrideOptions = () => {
  const { balances } = useWallets()
  const { chainId } = useEulerAddresses()

  // Local mirror of slot-hint state so callers can pass it explicitly and the
  // SDK has a fast path even on the first call after probing. The module-scope
  // cache inside the SDK is the source of truth long-term; this Map just lets
  // us snapshot it for the very-next call.
  const slotHints = ref<SlotHints>({})

  const primeSlotHintsFor = async (tokens: Address[]): Promise<void> => {
    if (!tokens.length) return
    const cid = chainId.value
    if (!cid) return
    try {
      const sdk = await getEulerSdkForChain(cid)
      const permit2Address = sdk.deploymentService.getDeployment(cid).addresses.coreAddrs.permit2 as Address
      // Use any chain-bound provider from the SDK so the slot probes share the
      // same proxy/transport the SDK normally uses (rate-limit and cache lines
      // up).
      const provider = sdk.providerService?.getProvider(cid)
      if (!provider) return
      const next: SlotHints = { ...slotHints.value }
      pendingStateOverrideHintResolutions.value += 1
      try {
        await Promise.all(tokens.map(async (rawToken) => {
          try {
            const token = getAddress(rawToken)
            const hint = await fetchErc20SlotHints(provider, token, {
              allowanceSpender: permit2Address,
            })
            next[token] = hint
          }
          catch (e) {
            logWarn('useStateOverrideOptions/primeSlotHintsFor', e)
          }
        }))
        slotHints.value = next
      }
      finally {
        pendingStateOverrideHintResolutions.value = Math.max(0, pendingStateOverrideHintResolutions.value - 1)
      }
    }
    catch (e) {
      logWarn('useStateOverrideOptions/primeSlotHintsFor', e)
    }
  }

  /**
   * Snapshot the current `useWallets` balances into the SDK's expected shape
   * (`Record<Address, bigint>` keyed by checksummed token address).
   */
  const buildWalletBalances = (): Record<Address, bigint> => {
    const out: Record<Address, bigint> = {}
    for (const [token, value] of balances.value.entries()) {
      try {
        out[getAddress(token) as Address] = value
      }
      catch {
        // skip malformed keys silently — the SDK will fall back to balanceOf
      }
    }
    return out
  }

  /**
   * Assemble `SimulationStateOverrideOptions` for the next simulate/estimate
   * call. Pass `noBalanceOverride: true` from any form that validates wallet
   * balance up front (multiply, deposit-with-swap, repay-with-swap, …).
   */
  const buildStateOverrideOptions = (opts?: {
    noBalanceOverride?: boolean
    noAllowanceOverride?: boolean
  }): SimulationStateOverrideOptions => {
    return {
      noBalanceOverride: opts?.noBalanceOverride,
      noAllowanceOverride: opts?.noAllowanceOverride,
      wallet: {
        balances: buildWalletBalances(),
      },
      slotHints: slotHints.value,
    }
  }

  return {
    primeSlotHintsFor,
    buildStateOverrideOptions,
    slotHints,
  }
}

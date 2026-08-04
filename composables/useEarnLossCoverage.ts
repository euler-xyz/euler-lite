import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { erc20Abi, isAddress, type Address } from 'viem'
import { computed, ref, watchEffect, type Ref } from 'vue'
import { EARN_LOSS_COVERAGE_ADDRESS } from '~/utils/vault/earn-losses'
import { createRaceGuard } from '~/utils/race-guard'
import { logWarn } from '~/utils/errorHandling'

type EarnCoverageTarget = Pick<EulerEarn, 'address' | 'lostAssets'>

/**
 * Reads the EulerEarn share balance parked at `address(1)`, the canonical sink
 * used to cover a vault's realised losses.
 *
 * `coverageShares` is `undefined` both while a read is in flight and after one
 * fails, so callers must consult `isCoverageLoading` to tell those apart:
 * withhold the figure while loading, and treat a settled `undefined` as no
 * coverage — which overstates rather than understates what is unbacked.
 *
 * Only reads when the vault actually recorded a shortfall — a vault with
 * `lostAssets == 0` has nothing to net off, so the common case costs no RPC.
 */
export const useEarnLossCoverage = (vault: Ref<EarnCoverageTarget | undefined>) => {
  const { client } = useRpcClient()

  const coverageShares = ref<bigint | undefined>(undefined)
  const isLoading = ref(false)
  const guard = createRaceGuard()

  watchEffect(async () => {
    const target = vault.value
    const rpcClient = client.value
    const gen = guard.next()

    if (!target || target.lostAssets <= 0n || !isAddress(target.address) || !rpcClient) {
      coverageShares.value = undefined
      isLoading.value = false
      return
    }

    // Drop the previous vault's coverage before awaiting. The race guard stops a
    // stale response from landing later, but it cannot retract a value already
    // committed — leaving it in place would net this vault's shortfall against
    // another vault's shares and understate what is actually uncovered.
    coverageShares.value = undefined
    isLoading.value = true

    try {
      const shares = await rpcClient.readContract({
        address: target.address as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        authorizationList: undefined,
        args: [EARN_LOSS_COVERAGE_ADDRESS],
      }) as bigint

      if (guard.isStale(gen)) return
      coverageShares.value = shares
    }
    catch (error) {
      if (guard.isStale(gen)) return
      coverageShares.value = undefined
      logWarn('earn/loss-coverage', error)
    }
    finally {
      if (!guard.isStale(gen)) isLoading.value = false
    }
  })

  return {
    coverageShares,
    isCoverageLoading: computed(() => isLoading.value),
  }
}

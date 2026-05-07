import { getAddress, zeroAddress, type Address, type Hash } from 'viem'
import { logger } from '~/utils/logger'
import { evcDisableCollateralAbi, evcDisableControllerAbi } from '~/abis/evc'
import { eulerAccountLensABI } from '~/entities/euler/abis'
import type { EVCCall } from '~/utils/evc-converter'
import { getPublicClient } from '~/utils/public-client'
import { SaHooksBuilder } from '~/entities/saHooksSDK'
import { fetchAccountPositions } from '~/utils/subgraph'

interface CleanupParams {
  evcAddress: Address
  accountLensAddress: Address
  subAccount: Address
  providerUrl: string
  subgraphUrl: string
  /** Collateral addresses accepted by the controller (BLTV > 0). Collaterals in
   *  this list are only disabled when they have zero balance (no deposit). */
  acceptedCollaterals?: string[]
}

interface EVCAccountInfo {
  enabledControllers: readonly Address[]
  enabledCollaterals: readonly Address[]
}

export async function buildCollateralCleanupCalls(params: CleanupParams): Promise<EVCCall[]> {
  const { evcAddress, accountLensAddress, subAccount, providerUrl, subgraphUrl, acceptedCollaterals } = params

  try {
    const client = getPublicClient(providerUrl)

    const info = await client.readContract({
      address: accountLensAddress,
      abi: eulerAccountLensABI,
      functionName: 'getEVCAccountInfo',
      args: [evcAddress, subAccount],
    }) as EVCAccountInfo

    const controllers = info.enabledControllers || []
    const collaterals = info.enabledCollaterals || []

    if (controllers.length === 0 && collaterals.length === 0) {
      return []
    }

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(evcAddress, [...evcDisableCollateralAbi])

    const evcCalls: EVCCall[] = []

    // Branch 1: No controllers — just disable all stale collaterals
    if (controllers.length === 0) {
      for (const collateral of collaterals) {
        evcCalls.push({
          targetContract: evcAddress,
          onBehalfOfAccount: zeroAddress,
          value: 0n,
          data: hooks.getDataForCall(evcAddress, 'disableCollateral', [subAccount, collateral]) as Hash,
        })
      }
      return evcCalls
    }

    const { borrows, deposits } = await fetchAccountPositions(subgraphUrl, subAccount)
    const normalizedSubAccount = getAddress(subAccount)
    const hasActiveBorrows = borrows.some(b => b.subAccount === normalizedSubAccount)

    // Branch 2: Controllers exist but no active borrows — disable everything
    if (!hasActiveBorrows) {
      for (const collateral of collaterals) {
        evcCalls.push({
          targetContract: evcAddress,
          onBehalfOfAccount: zeroAddress,
          value: 0n,
          data: hooks.getDataForCall(evcAddress, 'disableCollateral', [subAccount, collateral]) as Hash,
        })
      }

      for (const controller of controllers) {
        const controllerAddr = controller as Address
        hooks.addContractInterface(controllerAddr, [...evcDisableControllerAbi])
        evcCalls.push({
          targetContract: controllerAddr,
          onBehalfOfAccount: subAccount,
          value: 0n,
          data: hooks.getDataForCall(controllerAddr, 'disableController', []) as Hash,
        })
      }

      return evcCalls
    }

    // Branch 3: Active borrows exist — only disable collaterals that don't
    // contribute to the health score
    const depositSet = new Set(
      deposits
        .filter(d => d.subAccount === normalizedSubAccount)
        .map(d => getAddress(d.vault)),
    )

    const acceptedSet = new Set(
      (acceptedCollaterals || []).map(a => getAddress(a)),
    )

    for (const collateral of collaterals) {
      const normalized = getAddress(collateral)
      // Keep collaterals that are accepted by the controller and have balance —
      // they contribute to the health score
      if (acceptedSet.has(normalized) && depositSet.has(normalized)) continue
      // Also keep collaterals with deposits even if not accepted (safe default)
      if (depositSet.has(normalized)) continue
      evcCalls.push({
        targetContract: evcAddress,
        onBehalfOfAccount: zeroAddress,
        value: 0n,
        data: hooks.getDataForCall(evcAddress, 'disableCollateral', [subAccount, collateral]) as Hash,
      })
    }

    return evcCalls
  }
  catch (error) {
    logger.error({ ctx: 'collateral-cleanup', err: error }, 'failed to build collateral cleanup calls')
    return []
  }
}

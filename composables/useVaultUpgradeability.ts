import type { VaultAssessment } from '@eulerxyz/euler-v2-sdk'
import { getAddress, isAddress, zeroAddress } from 'viem'
import { toValue, type MaybeRefOrGetter } from 'vue'
import { vaultFactoryConfigAbi } from '~/abis/vault-factory'
import { getUpgradeabilityEvidence, type UpgradeabilityEvidence } from '~/utils/vault-assessment/evidence'

export const useVaultUpgradeability = (
  address: MaybeRefOrGetter<string>,
  assessment: MaybeRefOrGetter<VaultAssessment | undefined>,
  fallbackReady: MaybeRefOrGetter<boolean>,
) => {
  const { chainId, eulerCoreAddresses } = useEulerAddresses()
  const { client } = useRpcClient()
  const evidence = computed(() => getUpgradeabilityEvidence(toValue(assessment)))
  const fallback = shallowRef<UpgradeabilityEvidence | null>(null)
  let requestId = 0

  watch([() => toValue(address), chainId, eulerCoreAddresses, client, evidence, () => toValue(fallbackReady)],
    async ([target, , core, rpcClient, assessed, ready]) => {
      const currentRequest = ++requestId
      fallback.value = null
      if (!ready || assessed || !isAddress(target) || !core?.eVaultFactory || !rpcClient) return
      try {
        const config = await rpcClient.readContract({
          address: getAddress(core.eVaultFactory),
          abi: vaultFactoryConfigAbi,
          functionName: 'getProxyConfig',
          args: [getAddress(target)],
          authorizationList: undefined,
        })
        if (currentRequest !== requestId || config.implementation === zeroAddress) return
        fallback.value = { upgradeable: config.upgradeable, implementation: config.implementation }
      }
      catch {
        // The absence of both sources leaves the property unshown.
      }
    }, { immediate: true })

  return { upgradeability: computed(() => evidence.value ?? fallback.value) }
}

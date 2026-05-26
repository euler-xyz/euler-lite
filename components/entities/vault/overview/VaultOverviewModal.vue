<script setup lang="ts">
import { isSecuritizeCollateralVault, type EulerEarn, type SecuritizeCollateralVault, type EVault, type PortfolioBorrowPosition, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { getAddress } from 'viem'

import { getPairBorrowVault, getPairCollateralVault } from '~/utils/borrow-pair'

const emits = defineEmits(['close'])
const router = useRouter()
const route = useRoute()

const { pair, vault, earnVault, extraVault, securitizeVault, collateralVaults, title = 'Market information' } = defineProps<{ pair?: AnyBorrowVaultPair | PortfolioBorrowPosition<VaultEntity>, vault?: EVault, earnVault?: EulerEarn, extraVault?: EVault, securitizeVault?: SecuritizeCollateralVault, collateralVaults?: (EVault | SecuritizeCollateralVault)[], title?: string }>()

const tab = ref()
const normalizeAddress = (address?: string) => {
  if (!address) {
    return ''
  }
  try {
    return getAddress(address)
  }
  catch {
    return ''
  }
}
const tabs = computed(() => {
  if (!pair) {
    return []
  }
  const list: Array<{ label: string, value: string | undefined, assets: { address: string, symbol: string }[] }> = [
    {
      label: 'Position details',
      value: undefined,
      assets: [getPairCollateralVault(pair).asset, getPairBorrowVault(pair).asset],
    },
  ]
  if (extraVault) {
    const extraAddress = normalizeAddress(extraVault.address)
    const collateralAddress = normalizeAddress(getPairCollateralVault(pair).address)
    const borrowAddress = normalizeAddress(getPairBorrowVault(pair).address)
    if (extraAddress && extraAddress !== collateralAddress && extraAddress !== borrowAddress) {
      list.push({
        label: extraVault.asset.symbol,
        value: 'multiply-collateral',
        assets: [extraVault.asset],
      })
    }
  }

  const collaterals = collateralVaults?.length ? collateralVaults : [getPairCollateralVault(pair)]
  collaterals.forEach((vault, index) => {
    list.push({
      label: vault.asset.symbol,
      value: `collateral-${index}`,
      assets: [vault.asset],
    })
  })

  list.push({
    label: getPairBorrowVault(pair).asset.symbol,
    value: 'borrow',
    assets: [getPairBorrowVault(pair).asset],
  })
  return list
})
watch(tabs, (next) => {
  if (!tab.value) {
    return
  }
  const values = next.map(item => item.value)
  if (!values.includes(tab.value)) {
    tab.value = undefined
  }
}, { immediate: true })

const activeCollateralVault = computed(() => {
  if (!tab.value?.startsWith('collateral-')) return null
  const index = parseInt(tab.value.split('-')[1])
  const collaterals = collateralVaults?.length ? collateralVaults : (pair ? [getPairCollateralVault(pair)] : [])
  return collaterals?.[index] ?? null
})
const isSecuritizeVault = (vault: EVault | SecuritizeCollateralVault | null | undefined): vault is SecuritizeCollateralVault =>
  !!vault && isSecuritizeCollateralVault(vault)

const navigateToBorrow = (collateralAddress: string, borrowVaultAddress: string) => {
  emits('close')
  router.push({ path: `/borrow/${collateralAddress}/${borrowVaultAddress}`, query: { network: route.query.network } })
}
</script>

<template>
  <BaseModalWrapper
    class="w-full max-w-[500px]"
    full
    :title="title"
    @close="$emit('close')"
  >
    <UiTabs
      v-if="tabs.length"
      v-model="tab"
      class="mb-12 mx-[-16px]"
      rounded
      pills
      :list="tabs"
    >
      <template #default="{ tab: slotTab }">
        <div class="flex items-center gap-8">
          <AssetAvatar :asset="slotTab.assets" />
          {{ slotTab.label }}
        </div>
      </template>
    </UiTabs>

    <div
      class="flex flex-col flex-grow mx-[-8px]"
    >
      <template v-if="pair">
        <Transition
          name="page"
          mode="out-in"
        >
          <VaultOverviewPair
            v-if="!tab"
            :pair="pair"
            :collateral-vaults="collateralVaults"
            style="flex-grow: 1"
          />
          <SecuritizeVaultOverview
            v-else-if="isSecuritizeVault(activeCollateralVault)"
            :vault="(activeCollateralVault as SecuritizeCollateralVault)"
          />
          <VaultOverview
            v-else-if="activeCollateralVault"
            :vault="(activeCollateralVault as EVault)"
            @vault-click="(address: string) => navigateToBorrow(address, (activeCollateralVault as EVault).address)"
          />
          <VaultOverview
            v-else-if="tab === 'multiply-collateral' && extraVault"
            :vault="extraVault"
            @vault-click="(address: string) => navigateToBorrow(address, extraVault!.address)"
          />
          <VaultOverview
            v-else-if="tab === 'borrow'"
            :vault="getPairBorrowVault(pair)"
            @vault-click="(address: string) => navigateToBorrow(address, getPairBorrowVault(pair!).address)"
          />
        </Transition>
      </template>

      <template v-else-if="vault">
        <VaultOverview
          :vault="vault"
          @vault-click="(address: string) => navigateToBorrow(address, vault!.address)"
        />
      </template>

      <template v-else-if="securitizeVault">
        <SecuritizeVaultOverview
          :vault="securitizeVault"
        />
      </template>

      <template v-else-if="earnVault">
        <VaultOverviewEarn
          :vault="earnVault"
          @vault-click="(address: string) => { emits('close'); router.push({ path: `/lend/${address}`, query: { network: route.query.network } }) }"
        />
      </template>
    </div>
  </BaseModalWrapper>
</template>

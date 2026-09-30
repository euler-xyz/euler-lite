<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'
import { getEntitiesByVault } from '~/utils/eulerLabelsUtils'

const emits = defineEmits<{
  'vault-click': [address: string]
  'market-click': []
}>()
const { vault } = defineProps<{ vault: EVault, desktopOverview?: boolean }>()
const entities = computed(() => getEntitiesByVault(vault))
const { isVaultGovernorVerified } = useVaults()
const isVerified = computed(() => isVaultGovernorVerified(vault))

const isCyclicalIRM = computed(() => vault.interestRateModel.type === INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY
  || vault.interestRateModel.type === INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY_MONTHLY)
</script>

<template>
  <div
    class="flex flex-col"
    :class="[desktopOverview ? 'gap-16' : 'gap-12']"
  >
    <VaultOverviewBlockGeneral
      :vault="vault"
      :default-open="true"
      @market-click="emits('market-click')"
    />

    <VaultOverviewBlockStats
      :vault="vault"
      :default-open="true"
    />

    <VaultOverviewBlockHistory
      :vault="vault"
      :default-open="true"
    />

    <VaultOverviewBlockActivity
      :vault="vault"
      vault-type="evk"
      :default-open="false"
    />

    <VaultOverviewBlockRiskParameters
      :vault="vault"
      :default-open="false"
    />

    <VaultOverviewBlockVaultChecks
      :address="vault.address"
      :default-open="false"
    />

    <VaultOverviewBlockOracleAdapters
      :vault="vault"
      :default-open="false"
    />

    <VaultOverviewBlockBorrow
      :vault="vault"
      :default-open="false"
      @vault-click="(address: string) => emits('vault-click', address)"
    />

    <LazyVaultOverviewBlockCyclicalIRM
      v-if="isCyclicalIRM"
      :vault="vault"
      :default-open="false"
    />
    <LazyVaultOverviewBlockIRM
      v-else
      :vault="vault"
      :default-open="false"
    />

    <VaultOverviewBlockAddresses
      :vault="vault"
      :default-open="false"
    />

    <VaultEntityDisclosures
      v-if="isVerified"
      :entities="entities"
    />
  </div>
</template>

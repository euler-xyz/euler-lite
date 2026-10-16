<script setup lang="ts">
import type { BorrowVaultPair } from '~/types/borrow-pair'
import { isSecuritizeCollateralVault, type EulerEarn, type SecuritizeCollateralVault, type EVault, type PortfolioBorrowPosition, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { VaultOverviewModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import { useMediaQuery } from '@vueuse/core'

const { vault, pair, earnVault, extraVault, revealOracleLink = false } = defineProps<{ vault?: EVault | SecuritizeCollateralVault, pair?: BorrowVaultPair | PortfolioBorrowPosition<VaultEntity>, earnVault?: EulerEarn, extraVault?: EVault, disabled?: boolean, revealOracleLink?: boolean }>()
const modal = useModal()
const route = useRoute()
const isMobileOverview = useMediaQuery('(max-width: 900px)')
let infoModalId: number | undefined

const isSecuritize = (v: EVault | SecuritizeCollateralVault | undefined): v is SecuritizeCollateralVault =>
  !!v && isSecuritizeCollateralVault(v)

const onClick = () => {
  infoModalId = modal.open(VaultOverviewModal, {
    props: {
      title: 'Vault information',
      pair: pair,
      vault: isSecuritize(vault) ? undefined : vault,
      securitizeVault: isSecuritize(vault) ? vault : undefined,
      earnVault: earnVault,
      extraVault,
    },
  })
}

watch(
  () => revealOracleLink && pair && isMobileOverview.value ? route.hash : '',
  (hash) => {
    if (/^#oracle-adapter-0x[a-fA-F0-9]{40}$/.test(hash) && !modal.list.some(item => item.id === infoModalId)) onClick()
  },
  { immediate: true, flush: 'post' },
)
</script>

<template>
  <UiButton
    size="large"
    variant="primary-stroke"
    :disabled="disabled"
    @click="onClick"
  >
    {{ pair ? 'Pair information' : 'Vault information' }}
  </UiButton>
</template>

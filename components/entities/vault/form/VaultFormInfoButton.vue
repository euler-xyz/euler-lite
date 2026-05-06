<script setup lang="ts">
import type { BorrowVaultPair } from '~/types/borrow-pair'
import { isSecuritizeCollateralVault, type EulerEarn, type SecuritizeCollateralVault, type EVault, type PortfolioBorrowPosition, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { VaultOverviewModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'

const { vault, pair, earnVault, extraVault } = defineProps<{ vault?: EVault | SecuritizeCollateralVault, pair?: BorrowVaultPair | PortfolioBorrowPosition<VaultEntity>, earnVault?: EulerEarn, extraVault?: EVault, disabled?: boolean }>()
const modal = useModal()

const isSecuritize = (v: EVault | SecuritizeCollateralVault | undefined): v is SecuritizeCollateralVault =>
  !!v && isSecuritizeCollateralVault(v)

const onClick = () => {
  modal.open(VaultOverviewModal, {
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

<script setup lang="ts">
import type { BorrowVaultPair, EulerEarn, SecuritizeCollateralVault, EVault } from '~/entities/vault'
import { VaultOverviewModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import type { AccountBorrowPosition } from '~/entities/account'

const { vault, pair, earnVault, extraVault } = defineProps<{ vault?: EVault | SecuritizeCollateralVault, pair?: BorrowVaultPair | AccountBorrowPosition, earnVault?: EulerEarn, extraVault?: EVault, disabled?: boolean }>()
const modal = useModal()

const isSecuritize = (v: EVault | SecuritizeCollateralVault | undefined): v is SecuritizeCollateralVault =>
  !!v && 'type' in v && v.type === 'securitize'

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

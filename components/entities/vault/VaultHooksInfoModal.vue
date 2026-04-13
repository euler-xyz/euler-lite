<script setup lang="ts">
import type { Vault } from '~/entities/vault'
import {
  areAllUserOpsHooked,
  decodeHookedOps,
  isHookDisabling,
} from '~/utils/vault-hooks'
import { getExplorerLink } from '~/utils/block-explorer'
import { isVaultKeyring } from '~/utils/eulerLabelsUtils'
import { useEulerAddresses } from '~/composables/useEulerAddresses'

const emits = defineEmits(['close'])
const { vault } = defineProps<{ vault: Vault }>()

const { chainId } = useEulerAddresses()

const allDisabled = computed(() =>
  isHookDisabling(vault) && areAllUserOpsHooked(vault.hookedOps),
)

const title = computed(() => {
  if (allDisabled.value) return 'Paused'
  return isHookDisabling(vault) ? 'Disabled operations' : 'Hooked operations'
})

const intro = computed(() => {
  if (allDisabled.value) {
    return 'This vault is paused — every user-facing operation currently reverts. It may be a freshly-deployed vault that has not been activated yet, or it has been fully paused by its governor.'
  }
  if (isHookDisabling(vault)) {
    return 'The following operations will revert on this vault.'
  }
  return 'The following operations are routed through a hook contract, which may restrict or modify them.'
})

const ops = computed(() => decodeHookedOps(vault.hookedOps))

const hasHookTarget = computed(() => !isHookDisabling(vault))

const hookTargetLink = computed(() => getExplorerLink(vault.hookTarget, chainId.value, true))

const hookTargetLabel = computed(() => {
  if (isVaultKeyring(vault.address)) return 'Keyring (identity verification)'
  return 'Third-party hook contract'
})

const shortenAddress = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`

const handleClose = () => {
  emits('close')
}
</script>

<template>
  <BaseModalWrapper
    :title="title"
    @close="handleClose"
  >
    <p class="text-p2 text-content-primary mb-16">
      {{ intro }}
    </p>

    <div
      v-if="hasHookTarget"
      class="bg-surface-secondary rounded-12 p-16 mb-16 flex flex-col gap-4"
    >
      <p class="text-content-secondary text-p3">
        {{ hookTargetLabel }}
      </p>
      <NuxtLink
        :to="hookTargetLink"
        target="_blank"
        rel="noopener noreferrer"
        class="text-accent-600 underline hover:text-accent-500 break-all"
      >
        {{ shortenAddress(vault.hookTarget) }}
      </NuxtLink>
    </div>

    <div
      v-if="ops.length > 0"
      class="flex flex-col gap-16"
    >
      <div
        v-for="op in ops"
        :key="op.name"
        class="flex flex-col gap-4"
      >
        <p class="text-p2 font-semibold text-content-primary">
          {{ op.name }}
        </p>
        <p class="text-p3 text-content-secondary">
          {{ op.description }}
        </p>
        <p
          v-if="op.affectedFlows.length > 0"
          class="text-p3 text-content-tertiary"
        >
          May affect: {{ op.affectedFlows.join(', ') }}
        </p>
      </div>
    </div>
  </BaseModalWrapper>
</template>

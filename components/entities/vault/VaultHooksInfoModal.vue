<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import {
  areAllUserOpsHooked,
  getHookedOperationMetas,
  getVaultHookedOperations,
  getVaultHookTarget,
  isHookDisabling,
  isOpHooked,
  OP_VAULT_STATUS_CHECK,
} from '~/utils/vault-hooks'
import { getExplorerLink } from '~/utils/block-explorer'
import { getSpecialAddressLabel } from '~/utils/special-addresses'
import { isVaultAccessControlled, isVaultKeyring } from '~/utils/eulerLabelsUtils'
import { truncate } from '~/utils/string-utils'

const emits = defineEmits<{ close: [] }>()
const { vault } = defineProps<{ vault: EVault }>()

const { chainId } = useEulerAddresses()

const hookedOperations = computed(() => getVaultHookedOperations(vault))

// 'full'         — all user-facing operations are hooked
// 'status-check' — only the vault-status check is disabled, which the EVC
//                  calls at the end of every batch → every operation reverts
// null           — not paused (either fully or at all)
const pausedKind = computed((): 'full' | 'status-check' | null => {
  if (!isHookDisabling(vault)) return null
  if (areAllUserOpsHooked(hookedOperations.value)) return 'full'
  if (isOpHooked(vault, OP_VAULT_STATUS_CHECK)) return 'status-check'
  return null
})

const paused = computed(() => pausedKind.value !== null)

const title = computed(() => {
  if (paused.value) return 'Paused'
  return isHookDisabling(vault) ? 'Disabled operations' : 'Hooked operations'
})

const intro = computed(() => {
  if (pausedKind.value === 'full') {
    return 'All user-facing operations on this vault have been disabled by its risk manager. This typically indicates a freshly-deployed vault that has not been activated yet, or a full pause.'
  }
  if (pausedKind.value === 'status-check') {
    return 'The vault-status check has been disabled. This check is performed on every operation that touches the vault, so every operation reverts until the risk manager re-enables it.'
  }
  if (isHookDisabling(vault)) {
    return 'The following operations will revert on this vault.'
  }
  return 'The following operations are routed through a hook contract, which may restrict or modify them.'
})

const ops = computed(() => getHookedOperationMetas(hookedOperations.value))

const hasHookTarget = computed(() => !isHookDisabling(vault))

const hookTarget = computed(() => getVaultHookTarget(vault))

const hookTargetLink = computed(() => getExplorerLink(hookTarget.value, chainId.value, true))

const hookTargetLabel = computed(() => {
  if (isVaultKeyring(vault.address)) return 'Keyring (identity verification)'
  if (isVaultAccessControlled(vault.address)) return 'Access control (allowlist)'
  return 'Third-party hook contract'
})

// Extra explanation shown for permissioned vaults that gate operations behind
// an on-chain allowlist (access-control hook target).
const hookTargetNote = computed(() =>
  isVaultAccessControlled(vault.address)
    ? 'This vault is permissioned: the operations below can only be performed by addresses that the vault manager has added to an on-chain allowlist. If your address is not whitelisted, those operations will revert. Access is granted by the manager — there is no self-service verification.'
    : '',
)

const { copyToClipboard } = useClipboardCopy()

const onCopyClick = (address: string) => {
  copyToClipboard(address).catch(() => {})
}

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
      class="bg-surface-secondary rounded-12 p-16 mb-16 flex flex-col gap-8"
    >
      <p class="text-content-secondary text-p3">
        {{ hookTargetLabel }}
      </p>
      <div class="flex gap-4 items-center">
        <NuxtLink
          :to="hookTargetLink"
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent-600 underline cursor-pointer hover:text-accent-500"
        >
          {{ getSpecialAddressLabel(hookTarget) || truncate(hookTarget) }}
        </NuxtLink>
        <button
          type="button"
          aria-label="Copy hook target address"
          class="text-content-muted cursor-pointer outline-none hover:text-content-secondary active:text-content-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600 focus-visible:rounded"
          @click="onCopyClick(hookTarget)"
        >
          <SvgIcon
            class="!w-18 !h-18"
            name="copy"
          />
        </button>
      </div>
      <p
        v-if="hookTargetNote"
        class="text-p3 text-content-tertiary"
      >
        {{ hookTargetNote }}
      </p>
    </div>

    <div
      v-if="!paused && ops.length > 0"
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
          Also affects: {{ op.affectedFlows.join(', ') }}
        </p>
      </div>
    </div>
  </BaseModalWrapper>
</template>

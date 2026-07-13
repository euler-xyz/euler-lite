<script setup lang="ts">
import type {
  ActivityVaultType,
  EVault,
  VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import {
  buildActivityFeedContextKey,
  type ActivityFeedScope,
} from '~/composables/useActivityFeed'
import { getVaultActivityFilterOptions } from '~/utils/activity-display'
import { isVaultBorrowable } from '~/utils/vault/classification'

const props = withDefaults(defineProps<{
  vault: VaultEntity
  vaultType: ActivityVaultType
  defaultOpen?: boolean
}>(), {
  defaultOpen: false,
})

const { chainId } = useEulerAddresses()
const isOpen = ref(props.defaultOpen)
const hasCheckedRuntimeSupport = ref(false)
const isRuntimeUnsupported = ref(false)
const availabilityScope = computed(() => ({
  kind: 'vault' as const,
  vaultType: props.vaultType,
}))
const availability = useActivityAvailability(availabilityScope, chainId)
const feedScope = computed<ActivityFeedScope>(() => ({
  kind: 'vault',
  vault: getAddress(props.vault.address),
  chainId: Number(chainId.value),
  vaultType: props.vaultType,
}))
const feedContextKey = computed(() => buildActivityFeedContextKey(feedScope.value, []))
const isBorrowable = computed(() =>
  props.vaultType === 'evk' && isVaultBorrowable(props.vault as EVault),
)
const categoryOptions = computed(() => getVaultActivityFilterOptions(props.vaultType, {
  borrowable: isBorrowable.value,
}))

const setRuntimeUnsupported = (unsupported: boolean) => {
  isRuntimeUnsupported.value = unsupported
  if (unsupported) isOpen.value = false
}

watch(feedScope, () => {
  hasCheckedRuntimeSupport.value = false
  isRuntimeUnsupported.value = false
  isOpen.value = props.defaultOpen
})
</script>

<template>
  <VaultOverviewAccordionSection
    v-if="availability.shouldRender.value && !isRuntimeUnsupported"
    v-show="availability.reason.value === 'capability-check-failed' || hasCheckedRuntimeSupport"
    :key="feedContextKey"
    title="Activity"
    :default-open="defaultOpen"
    :keep-mounted="true"
    content-class="flex flex-col gap-16"
    @update:open="isOpen = $event"
  >
    <div
      v-if="availability.reason.value === 'capability-check-failed'"
      class="flex flex-col items-center gap-12 rounded-12 border border-line-subtle bg-surface p-24 text-center"
      role="alert"
    >
      <div class="text-p3 text-content-primary">
        Activity availability could not be checked right now.
      </div>
      <button
        type="button"
        class="ui-button ui-button--medium ui-button--secondary"
        :disabled="availability.isChecking.value"
        @click="availability.refreshAvailability"
      >
        {{ availability.isChecking.value ? 'Retrying…' : 'Retry' }}
      </button>
    </div>
    <ActivityFeed
      v-else
      :scope="feedScope"
      :enabled="availability.isSupported.value && (isOpen || !hasCheckedRuntimeSupport)"
      :category-options="categoryOptions"
      @settled="hasCheckedRuntimeSupport = true"
      @update:unsupported="setRuntimeUnsupported"
    />
  </VaultOverviewAccordionSection>
</template>

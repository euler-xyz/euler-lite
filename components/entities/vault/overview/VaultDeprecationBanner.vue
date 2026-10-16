<script setup lang="ts">
import { autoLink } from '~/utils/autoLink'
import { getVaultDeprecation } from '~/utils/eulerLabelsUtils'

const props = defineProps<{ reason?: string, addresses?: string[] }>()
const { isReady, visibility } = useEulerLabels()
const current = computed(() => {
  void isReady.value
  void visibility.value
  if (!props.addresses) return { deprecated: true, reason: props.reason ?? '' }
  const reasons = props.addresses.map(address => getVaultDeprecation(address))
    .filter(item => item.deprecated)
    .map(item => item.reason)
  return { deprecated: reasons.length > 0, reason: [...new Set(reasons)].join(' ') }
})
</script>

<template>
  <div
    v-if="current.deprecated"
    class="w-full rounded-12 p-16 bg-warning-100 text-warning-500"
  >
    <div class="flex items-center gap-8">
      <SvgIcon
        name="warning"
        class="!w-20 !h-20 flex-shrink-0"
      />
      <!-- eslint-disable vue/no-v-html -- autoLink escapes label text before adding links -->
      <p
        v-if="current.reason"
        class="text-p3 text-warning-500 auto-link"
        v-html="autoLink(current.reason)"
      />
      <!-- eslint-enable vue/no-v-html -->
      <p
        v-else
        class="text-p3 text-warning-500"
      >
        This vault has been deprecated.
      </p>
    </div>
  </div>
</template>

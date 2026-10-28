<script setup lang="ts">
import { getFlaggedVerdict } from '~/utils/vault-assessment/flagged'

const props = defineProps<{
  name: string
  isUnverified?: boolean
  addresses?: string[]
}>()

const { isReady, source, visibility } = useEulerLabels()
const { isVerifiedVault } = useVaultRegistry()
const isFlaggedOnly = computed(() => {
  if (!props.isUnverified || !isReady.value) return false
  const unverified = props.addresses?.filter(address => address && !isVerifiedVault(address)) ?? []
  return unverified.length > 0 && unverified.every(address => getFlaggedVerdict(address, source.value, visibility.value))
})
</script>

<template>
  <span
    v-if="props.isUnverified && (isReady || source !== 'v3') && !isFlaggedOnly"
    class="flex text-error-500 items-center gap-4"
  >
    <SvgIcon
      name="warning"
      class="!w-20 !h-20"
    />
    Unknown
  </span>
  <span v-else>{{ props.name }}</span>
</template>

<script setup lang="ts">
const props = defineProps<{
  name: string
  isUnverified?: boolean
  addresses?: string[]
}>()

const { isReady, source, visibility } = useEulerLabels()
const { isVerifiedVault } = useVaultRegistry()
const hasKnownUnlistedVerdict = computed(() => {
  if (!props.isUnverified || !isReady.value || source.value !== 'v3') return false
  const unverified = props.addresses?.filter(address => address && !isVerifiedVault(address)) ?? []
  return unverified.length > 0 && unverified.every((address) => {
    const status = visibility.value?.[address.toLowerCase()]?.status
    return status === 'hidden' || status === 'pending_review'
  })
})
</script>

<template>
  <span
    v-if="props.isUnverified && !hasKnownUnlistedVerdict"
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

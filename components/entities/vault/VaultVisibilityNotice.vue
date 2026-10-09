<script setup lang="ts">
import { getNotListedLine } from '~/utils/vault-assessment/presentation'

const props = defineProps<{ address: string }>()
const { isReady, source, visibility } = useEulerLabels()
const line = computed(() => {
  if (!isReady.value || source.value !== 'v3') return null
  const verdict = visibility.value?.[props.address.toLowerCase()]
  return getNotListedLine(verdict?.status, verdict?.reason, verdict?.decidedBy)
})
</script>

<template>
  <p
    v-if="line"
    class="text-p4 text-content-tertiary"
    data-id="vault-not-listed"
  >
    {{ line }}
  </p>
</template>

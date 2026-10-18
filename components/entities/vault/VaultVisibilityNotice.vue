<script setup lang="ts">
import { getFlaggedVaultLine, getFlaggedVerdict } from '~/utils/vault-assessment/flagged'

const props = defineProps<{ address: string }>()
const { isReady, source, visibility } = useEulerLabels()
const line = computed(() => {
  if (!isReady.value) return null
  const verdict = getFlaggedVerdict(props.address, source.value, visibility.value)
  return verdict ? getFlaggedVaultLine(verdict.reason) : null
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

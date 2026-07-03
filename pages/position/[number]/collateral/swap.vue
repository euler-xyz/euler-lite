<script setup lang="ts">
const route = useRoute()
const positionNumber = Array.isArray(route.params.number)
  ? route.params.number[0]
  : route.params.number
const legacyTargetCollateral = Array.isArray(route.query.to)
  ? route.query.to[0]
  : route.query.to
const query = { ...route.query }

delete query.to
if (typeof legacyTargetCollateral === 'string' && legacyTargetCollateral) {
  query.targetCollateral = legacyTargetCollateral
}

navigateTo({
  path: `/position/${positionNumber}/borrow/swap`,
  query,
  hash: route.hash,
}, { replace: true })
</script>

<template>
  <div />
</template>

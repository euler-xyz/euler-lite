<script setup lang="ts">
defineEmits<{ close: [] }>()

const bullets = [
  'Access is granted by the vault manager — there is no self-service verification',
  'If your address is not whitelisted, the gated operations will revert',
  'Which operations are gated depends on the vault\'s hook configuration',
]
</script>

<template>
  <UiInfoModal
    title="Access-controlled Vault"
    icon="search-user"
    headline="Permissioned Operations"
    body="This vault routes operations through an access-control hook. Only addresses on an on-chain allowlist can perform the gated operations."
    :bullets="bullets"
    @close="$emit('close')"
  />
</template>

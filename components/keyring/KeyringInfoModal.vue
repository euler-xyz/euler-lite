<script setup lang="ts">
defineEmits<{ close: [] }>()

const bullets = [
  'Install the Keyring browser extension to complete verification',
  'Credentials expire after a limited time and may need periodic renewal',
  'A small on-chain fee is paid during credential registration',
]
</script>

<template>
  <UiInfoModal
    title="Private Vault"
    icon="shield"
    headline="Identity Verification Required"
    body="This vault requires identity verification through Keyring Network before you can interact with it."
    :bullets="bullets"
    @close="$emit('close')"
  />
</template>

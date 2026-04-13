<script setup lang="ts">
const props = defineProps<{
  announcementUrl: string
}>()
const emits = defineEmits(['close'])
</script>

<template>
  <BaseModalWrapper
    title="The Euler app has a new interface"
    :close="false"
  >
    <div class="flex flex-col gap-16">
      <p class="text-secondary text-p3">
        We've streamlined the app for speed and reliability. All core functionality —
        lending, borrowing, and earn — is fully supported.
      </p>

      <ul class="flex flex-col gap-8 text-p3 text-secondary">
        <li class="flex items-start gap-8">
          <span class="text-accent shrink-0">&#10003;</span>
          <span>More reliable with fewer dependencies</span>
        </li>
        <li class="flex items-start gap-8">
          <span class="text-accent shrink-0">&#10003;</span>
          <span>Access to all your existing positions</span>
        </li>
        <li class="flex items-start gap-8">
          <span class="text-accent shrink-0">&#10003;</span>
          <span>A next-generation app is in development</span>
        </li>
      </ul>

      <p class="text-secondary text-p3">
        The legacy app is accessible via the link in the top-left corner but is no longer maintained.
      </p>

      <a
        v-if="props.announcementUrl"
        :href="props.announcementUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="text-accent text-p3 hover:underline"
      >
        Read the full announcement &rarr;
      </a>
    </div>

    <div class="flex justify-end mt-16">
      <UiButton
        size="xlarge"
        rounded
        variant="primary"
        @click="emits('close')"
      >
        Got it
      </UiButton>
    </div>
  </BaseModalWrapper>
</template>

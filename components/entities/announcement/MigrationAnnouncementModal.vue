<script setup lang="ts">
const props = defineProps<{
  announcementUrl: string
}>()
const emits = defineEmits(['close'])
</script>

<template>
  <BaseModalWrapper
    title="We've upgraded the Euler app"
    :close="false"
  >
    <div class="flex flex-col gap-16">
      <p class="text-secondary text-p3">
        We've replaced the previous interface with a lighter version while we build the
        next-generation Euler app. Everything works the same — lending, borrowing, and
        earn are all fully supported.
      </p>

      <ul class="flex flex-col gap-8 text-p3 text-secondary">
        <li class="flex items-start gap-8">
          <span class="text-accent shrink-0">&#10003;</span>
          <span>All features you rely on are fully supported</span>
        </li>
        <li class="flex items-start gap-8">
          <span class="text-accent shrink-0">&#10003;</span>
          <span>More reliable with fewer backend dependencies</span>
        </li>
        <li class="flex items-start gap-8">
          <span class="text-accent shrink-0">&#10003;</span>
          <span>A completely new app is in development</span>
        </li>
      </ul>

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

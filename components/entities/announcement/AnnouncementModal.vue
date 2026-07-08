<script setup lang="ts">
defineProps<{
  title: string
  body: string
  items: string[]
  announcementUrl?: string
}>()
const emits = defineEmits(['close'])
</script>

<template>
  <BaseModalWrapper
    :title="title || 'Announcement'"
    :close="false"
  >
    <div class="flex flex-col gap-16">
      <p
        v-if="body"
        class="text-content-secondary text-p3"
      >
        {{ body }}
      </p>

      <ul
        v-if="items.length"
        class="flex flex-col gap-8 text-p3 text-content-secondary"
      >
        <li
          v-for="item in items"
          :key="item"
          class="flex items-start gap-8"
        >
          <span class="text-accent-600 shrink-0">&#10003;</span>
          <span>{{ item }}</span>
        </li>
      </ul>

      <a
        v-if="announcementUrl"
        :href="announcementUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="text-accent-600 text-p3 hover:underline"
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

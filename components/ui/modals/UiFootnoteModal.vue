<script setup lang="ts">
defineEmits(['close'])
const { modalTitle, text, sections } = defineProps<{
  modalTitle: string
  text: string
  sections?: { title: string, text: string }[]
}>()
</script>

<template>
  <BaseModalWrapper
    :title="sections && sections.length > 1 ? 'Details' : modalTitle"
    @close="$emit('close')"
  >
    <template v-if="sections && sections.length > 1">
      <div class="flex flex-col gap-12">
        <div
          v-for="(section, idx) in sections"
          :key="idx"
          class="flex flex-col gap-4"
        >
          <div class="text-p2 font-semibold text-content-primary">
            {{ section.title }}
          </div>
          <div class="text-p2 text-content-primary">
            {{ section.text }}
          </div>
        </div>
      </div>
    </template>
    <div
      v-else
      class="text-p2 text-content-primary"
    >
      {{ text }}
    </div>
  </BaseModalWrapper>
</template>

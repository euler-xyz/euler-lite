<script setup lang="ts">
defineEmits(['close'])
type Section = { title: string, text: string }

const {
  modalTitle,
  text,
  sections,
  inline = false,
  close = true,
} = defineProps<{
  modalTitle: string
  text?: string
  sections?: Section[]
  inline?: boolean
  close?: boolean
}>()
</script>

<template>
  <BaseModalWrapper
    :title="modalTitle"
    :inline="inline"
    :close="close"
    @close="$emit('close')"
  >
    <template v-if="sections">
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

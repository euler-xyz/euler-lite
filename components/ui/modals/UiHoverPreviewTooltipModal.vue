<script setup lang="ts">
defineEmits(['close'])
type Section = { title: string, text: string, href?: string }

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
    :compact="inline && !close"
    @close="$emit('close')"
  >
    <template v-if="sections">
      <div class="flex flex-col gap-10">
        <div
          v-for="(section, idx) in sections"
          :key="idx"
          class="flex flex-col gap-4"
        >
          <div class="text-p3 font-semibold text-content-primary">
            {{ section.title }}
          </div>
          <a
            v-if="section.href"
            :href="section.href"
            class="w-fit break-all text-p3 text-accent-600 underline hover:text-accent-500"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ section.text }}
          </a>
          <div
            v-else
            class="text-p3 text-content-primary"
            style="white-space: pre-line"
          >
            {{ section.text }}
          </div>
        </div>
      </div>
    </template>
    <div
      v-else
      class="text-p3 text-content-primary"
      style="white-space: pre-line"
    >
      {{ text }}
    </div>
  </BaseModalWrapper>
</template>

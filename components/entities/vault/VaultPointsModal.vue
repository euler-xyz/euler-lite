<script setup lang="ts">
import { getEulerLabelEntityLogo, getEulerLabelPointLogo } from '~/entities/euler/labels'

defineEmits(['close'])
const { pointName, pointLogo, campaignType = 'deposit' } = defineProps<{
  pointName: string
  pointLogo: string
  campaignType?: 'deposit' | 'borrow'
}>()

const onLogoError = (event: Event) => {
  const img = event.target as HTMLImageElement
  if (!img.dataset.triedFallback) {
    img.dataset.triedFallback = 'true'
    img.src = getEulerLabelEntityLogo(pointLogo)
  }
}

const escapeHtml = (unsafe: string): string => {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

const isValidUrl = (url: string): boolean => {
  try {
    const urlObj = new URL(url)
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:'
  }
  catch {
    return false
  }
}

const convertMarkdownLinks = (text: string): string => {
  const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  let lastIndex = 0
  let result = ''
  let match

  while ((match = markdownLinkRegex.exec(text)) !== null) {
    result += escapeHtml(text.substring(lastIndex, match.index))
    const linkText = match[1]
    const url = match[2]
    if (isValidUrl(url)) {
      const safeUrl = escapeHtml(url)
      const safeText = escapeHtml(linkText)
      result += `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="text-accent-600 hover:underline">${safeText}</a>`
    }
    else {
      result += escapeHtml(linkText)
    }
    lastIndex = markdownLinkRegex.lastIndex
  }
  result += escapeHtml(text.substring(lastIndex))
  return result
}

const formattedPointName = computed(() => convertMarkdownLinks(pointName))
</script>

<template>
  <BaseModalWrapper
    title="Points"
    @close="$emit('close')"
  >
    <div class="flex items-center gap-12">
      <span class="text-p2">{{ campaignType === 'borrow' ? 'Borrowing earns' : 'Supply earns' }}</span>
      <img
        :src="getEulerLabelPointLogo(pointLogo)"
        alt="Point logo"
        referrerpolicy="no-referrer"
        class="w-20 h-20 rounded-full"
        @error="onLogoError"
      >
      <!-- eslint-disable vue/no-v-html -- trusted label content -->
      <span
        class="text-p2"
        v-html="formattedPointName"
      />
      <!-- eslint-enable vue/no-v-html -->
    </div>
  </BaseModalWrapper>
</template>

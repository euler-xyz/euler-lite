<script lang="ts">
</script>

<script setup lang="ts">
import { useImage } from '@vueuse/core'
import { stringToColor } from '~/utils/string-utils'

const loadedImages = new Set<string>()
const fallbackRedirects = reactive(new Map<string, string>())

defineOptions({
  inheritAttrs: false,
})
const { src, fallbackSrc, label } = defineProps<{ src?: string | string[], fallbackSrc?: string | string[], label?: string | string[] }>()
const images = computed(() => {
  const srcs = !src || typeof src === 'string' ? [src || ''] : [...src]
  const fallbacks = !fallbackSrc || typeof fallbackSrc === 'string' ? [fallbackSrc || ''] : [...fallbackSrc]
  const labels = !label || typeof label === 'string' ? [label || ''] : [...label]
  return srcs.map((s, index) => {
    const fb = fallbacks[index] || ''
    const effectiveSrc = (fb && fallbackRedirects.get(s) === fb) ? fb : s

    if (effectiveSrc && loadedImages.has(effectiveSrc)) {
      return { label: labels[index], src: effectiveSrc, state: { isReady: true } }
    }

    const state = reactive(useImage({ src: effectiveSrc, referrerPolicy: 'no-referrer' }))
    watch(() => state.isReady, (ready) => {
      if (ready && effectiveSrc) loadedImages.add(effectiveSrc)
    })

    if (effectiveSrc === s && fb) {
      watch(() => state.error, (err) => {
        if (err && !fallbackRedirects.has(s)) {
          fallbackRedirects.set(s, fb)
        }
      })
    }

    return { label: labels[index], src: effectiveSrc, state }
  })
})
</script>

<template>
  <div class="relative flex items-center shrink-0">
    <template
      v-for="(image, idx) in images"
      :key="idx"
    >
      <img
        v-if="image.state.isReady"
        class="w-24 h-24 flex items-center justify-center overflow-hidden rounded-full object-cover object-center flex-shrink-0 [&.icon--16]:!w-16 [&.icon--16]:!h-16 [&.icon--18]:!w-18 [&.icon--18]:!h-18 [&.icon--20]:!w-20 [&.icon--20]:!h-20 [&.icon--20]:text-[8px] [&.icon--24]:!w-24 [&.icon--24]:!h-24 [&.icon--32]:!w-32 [&.icon--32]:!h-32 [&.icon--36]:!w-36 [&.icon--36]:!h-36 [&.icon--38]:!w-38 [&.icon--38]:!h-38 [&.icon--40]:!w-40 [&.icon--40]:!h-40 [&.icon--46]:!w-46 [&.icon--46]:!h-46 [&.icon--46]:text-[16px] [&:not(:first-child)]:-ml-8 [&.icon--38:not(:first-child)]:-ml-18 [&.icon--40:not(:first-child)]:-ml-20 [&.icon--46:not(:first-child)]:-ml-18"
        v-bind="$attrs"
        :src="image.src"
        :alt="image.label || ''"
        referrerpolicy="no-referrer"
      >
      <div
        v-else
        class="w-24 h-24 flex items-center justify-center font-semibold overflow-hidden rounded-full bg-center bg-cover flex-shrink-0 border border-line-subtle [&.icon--16]:!w-16 [&.icon--16]:!h-16 [&.icon--18]:!w-18 [&.icon--18]:!h-18 [&.icon--20]:!w-20 [&.icon--20]:!h-20 [&.icon--20]:text-[8px] [&.icon--24]:!w-24 [&.icon--24]:!h-24 [&.icon--32]:!w-32 [&.icon--32]:!h-32 [&.icon--36]:!w-36 [&.icon--36]:!h-36 [&.icon--38]:!w-38 [&.icon--38]:!h-38 [&.icon--40]:!w-40 [&.icon--40]:!h-40 [&.icon--46]:!w-46 [&.icon--46]:!h-46 [&.icon--46]:text-[16px] [&:not(:first-child)]:-ml-8 [&.icon--38:not(:first-child)]:-ml-18 [&.icon--40:not(:first-child)]:-ml-20 [&.icon--46:not(:first-child)]:-ml-18"
        v-bind="$attrs"
        :style="{ backgroundColor: image.label ? stringToColor(image.label) : 'var(--neutral-300)', color: image.label ? 'var(--text-inverse)' : 'var(--text-tertiary)' }"
      >
        {{ image.label ? image.label.slice(0, 2) : '?' }}
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { EarnVault, Vault } from '~/entities/vault'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultPointsModal } from '#components'

const { vault } = defineProps<{ vault: Vault | EarnVault }>()

const points = useEulerPointsOfVault(vault.address)
const modal = useModal()

const onLogoError = (event: Event, logoFileName: string) => {
  const img = event.target as HTMLImageElement
  if (!img.dataset.triedFallback) {
    img.dataset.triedFallback = 'true'
    img.src = getEulerLabelEntityLogo(logoFileName)
  }
}

const onPointClick = (
  point: { name: string, logo: string },
  event: MouseEvent | TouchEvent,
) => {
  event.stopPropagation()
  event.preventDefault()
  modal.open(VaultPointsModal, {
    props: {
      pointName: point.name,
      pointLogo: point.logo,
    },
  })
}
</script>

<template>
  <div
    class="text-p1 flex items-center gap-0 hover:gap-8 transition-[gap] duration-300 ease-in-out"
  >
    <img
      v-for="(point, index) in points"
      :key="point.name"
      class="w-16 h-16 rounded-full cursor-pointer select-none"
      :class="{ '-ml-6': index > 0 }"
      :src="`/entities/${point.logo}`"
      alt="Points entity logo"
      referrerpolicy="no-referrer"
      draggable="false"
      @click="onPointClick(point, $event)"
      @error="onLogoError($event, point.logo)"
      @contextmenu.prevent
    >
  </div>
</template>

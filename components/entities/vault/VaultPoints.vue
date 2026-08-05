<script setup lang="ts">
import type { EulerEarn, EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getEulerLabelEntityLogo, getEulerLabelPointLogo } from '~/entities/euler/labels'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultPointsModal } from '#components'

const { vault, campaignType = 'deposit' } = defineProps<{
  vault: EVault | EulerEarn | SecuritizeCollateralVault
  campaignType?: 'deposit' | 'borrow'
}>()

const allPoints = useEulerPointsOfVault(vault.address)
const points = computed(() => allPoints.filter(point =>
  point.type ? point.type === campaignType : campaignType === 'deposit',
))
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
      campaignType,
    },
  })
}
</script>

<template>
  <div
    v-if="points.length"
    class="text-p1 flex items-center gap-0 hover:gap-8 transition-[gap] duration-300 ease-in-out"
  >
    <img
      v-for="(point, index) in points"
      :key="point.name"
      class="w-16 h-16 rounded-full cursor-pointer select-none"
      :class="{ '-ml-6': index > 0 }"
      :src="getEulerLabelPointLogo(point.logo)"
      alt="Points entity logo"
      referrerpolicy="no-referrer"
      draggable="false"
      @click="onPointClick(point, $event)"
      @error="onLogoError($event, point.logo)"
      @contextmenu.prevent
    >
  </div>
</template>

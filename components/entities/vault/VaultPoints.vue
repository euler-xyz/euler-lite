<script setup lang="ts">
import type { EulerEarn, EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getEulerLabelPointLogo } from '~/entities/euler/labels'
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
    <BaseAvatar
      v-for="(point, index) in points"
      :key="point.name"
      class="icon--16 rounded-full cursor-pointer select-none"
      :class="{ '-ml-6': index > 0 }"
      :src="getEulerLabelPointLogo(point.logo)"
      :label="point.name"
      @click="onPointClick(point, $event)"
      @contextmenu.prevent
    />
  </div>
</template>

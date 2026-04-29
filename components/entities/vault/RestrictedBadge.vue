<script setup lang="ts">
import { useModal } from '~/components/ui/composables/useModal'
import { RestrictedInfoModal } from '#components'

type Variant = 'blocked' | 'restricted'

const { variant = 'blocked', size = 'small' } = defineProps<{
  variant?: Variant
  size?: 'small' | 'large'
}>()

const modal = useModal()

const title = computed(() =>
  variant === 'restricted'
    ? 'This asset is restricted in your region'
    : 'This vault is not available in your region',
)

const openInfoModal = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  modal.open(RestrictedInfoModal, { props: { variant } })
}
</script>

<template>
  <span
    class="inline-flex items-center cursor-pointer rounded-8 bg-warning-100 text-warning-500"
    :class="size === 'large' ? 'gap-8 py-8 px-12' : 'gap-4 py-2 px-8 text-p5'"
    :title="title"
    @click="openInfoModal"
  >
    <SvgIcon
      name="warning"
      :class="size === 'large' ? '!w-20 !h-20 mr-2' : '!w-14 !h-14'"
    />
    Restricted
  </span>
</template>

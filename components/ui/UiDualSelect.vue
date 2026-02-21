<script setup lang="ts">
import { useModal } from '~/components/ui/composables/useModal'
import { UiDualSelectModal } from '#components'

type Option = { label: string, value: string, icon?: string, iconFallback?: string }

const modelA = defineModel<string[]>('collateral', { required: true })
const modelB = defineModel<string[]>('debt', { required: true })

const props = defineProps<{
  optionsA: Option[]
  optionsB: Option[]
  labelA: string
  labelB: string
  placeholder?: string
  icon?: string
}>()

const modal = useModal()

const totalSelected = computed(() => modelA.value.length + modelB.value.length)

const open = () => {
  modal.open(UiDualSelectModal, {
    props: {
      selectedA: modelA.value,
      selectedB: modelB.value,
      optionsA: props.optionsA,
      optionsB: props.optionsB,
      labelA: props.labelA,
      labelB: props.labelB,
      onSave: (selectedA: string[], selectedB: string[]) => {
        modelA.value = selectedA
        modelB.value = selectedB
        modal.close()
      },
    },
  })
}
</script>

<template>
  <div
    class="flex items-center gap-6 shrink-0 min-h-36 text-content-secondary text-[14px] py-6 px-12 bg-surface border border-line-default rounded-none cursor-pointer hover:border-line-emphasis hover:bg-surface-secondary transition-all"
    @click="open"
  >
    <UiIcon
      v-if="icon"
      :name="icon"
      class="!w-16 !h-16 text-content-tertiary"
    />
    <span class="whitespace-nowrap overflow-hidden text-ellipsis">{{ placeholder || 'Assets' }}</span>
    <span
      v-if="totalSelected"
      class="ui-select__plus"
    >+{{ totalSelected }}</span>
  </div>
</template>

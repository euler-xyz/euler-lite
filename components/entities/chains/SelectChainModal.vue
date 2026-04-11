<script setup lang="ts">
import { useChains } from '@wagmi/vue'

const emits = defineEmits<{ close: [] }>()
const chains = useChains()
const { deprecatedChainIds } = useChainConfig()
const deprecatedSet = new Set(deprecatedChainIds)

const activeChains = computed(() =>
  [...chains.value]
    .filter(c => !deprecatedSet.has(c.id))
    .sort((a, b) => a.id - b.id),
)
const deprecatedChains = computed(() =>
  [...chains.value]
    .filter(c => deprecatedSet.has(c.id))
    .sort((a, b) => a.id - b.id),
)

const showDeprecated = ref(false)
const { changeChain } = useWagmi()

const handleClose = () => {
  emits('close')
}
const onClick = (chainId: number) => {
  emits('close')
  setTimeout(() => {
    changeChain(chainId)
  }, 1000)
}
</script>

<template>
  <BaseModalWrapper
    title="Select chain"
    @close="handleClose"
  >
    <div class="mb-24">
      <ChainSelectorItem
        v-for="chain in activeChains"
        :key="chain.id"
        :chain-id="chain.id"
        :name="chain.name"
        @click="onClick(chain.id)"
      />

      <template v-if="deprecatedChains.length">
        <button
          type="button"
          class="flex items-center justify-between w-full pt-12 pb-8 cursor-pointer text-content-secondary"
          :aria-expanded="showDeprecated"
          @click="showDeprecated = !showDeprecated"
        >
          <span class="text-[14px] font-medium">Deprecated chains</span>
          <SvgIcon
            name="arrow-down"
            class="!w-16 !h-16 transition-transform duration-fast"
            :class="showDeprecated ? 'rotate-180' : ''"
          />
        </button>

        <template v-if="showDeprecated">
          <ChainSelectorItem
            v-for="chain in deprecatedChains"
            :key="chain.id"
            :chain-id="chain.id"
            :name="chain.name"
            deprecated
            @click="onClick(chain.id)"
          />
        </template>
      </template>
    </div>
  </BaseModalWrapper>
</template>

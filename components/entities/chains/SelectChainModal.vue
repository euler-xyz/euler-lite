<script setup lang="ts">
import { useChains } from '@wagmi/vue'

const emits = defineEmits(['close'])
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
      <div
        v-for="chain in activeChains"
        :key="chain.id"
        class="flex items-center py-12 font-semibold leading-20 text-[16px] cursor-pointer"
        @click="onClick(chain.id)"
      >
        <BaseAvatar
          class="mr-8 w-32 h-32 shadow-[inset_0_0_0_1px_var(--border-subtle)] rounded-full"
          :src="`/chains/${chain.id}.webp`"
          :label="chain.name"
        />
        {{ chain.name }}
      </div>

      <template v-if="deprecatedChains.length">
        <div
          class="flex items-center justify-between pt-12 pb-0 cursor-pointer text-content-secondary"
          @click="showDeprecated = !showDeprecated"
        >
          <span class="text-[14px] font-medium">Deprecated chains</span>
          <SvgIcon
            name="arrow-down"
            class="!w-16 !h-16 transition-transform duration-fast"
            :class="showDeprecated ? 'rotate-180' : ''"
          />
        </div>

        <template v-if="showDeprecated">
          <div
            v-for="chain in deprecatedChains"
            :key="chain.id"
            class="flex items-center py-12 font-semibold leading-20 text-[16px] cursor-pointer"
            @click="onClick(chain.id)"
          >
            <BaseAvatar
              class="mr-8 w-32 h-32 shadow-[inset_0_0_0_1px_var(--border-subtle)] rounded-full"
              :src="`/chains/${chain.id}.webp`"
              :label="chain.name"
            />
            {{ chain.name }}
          </div>
        </template>
      </template>
    </div>
  </BaseModalWrapper>
</template>

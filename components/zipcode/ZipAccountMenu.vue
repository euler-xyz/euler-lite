<script setup lang="ts">
import { onClickOutside } from '@vueuse/core'
import { demoConfig } from '~/types/zipcode'

const { reset } = useZipDemo()
const { flags } = useZipFeatureFlags()
const router = useRouter()

const open = ref(false)
const root = ref<HTMLElement>()
onClickOutside(root, () => {
  open.value = false
})

const initials = computed(() =>
  demoConfig.lenderName.split(' ').map(p => p[0]).slice(0, 2).join(''),
)

const go = (to: string) => {
  open.value = false
  void router.push(to)
}

const onReset = () => {
  open.value = false
  reset()
  void router.push('/zipcode/earn')
}
</script>

<template>
  <div
    ref="root"
    class="relative shrink-0"
  >
    <button
      type="button"
      class="flex items-center gap-8 pl-8 pr-10 py-6 rounded-12 border transition-colors"
      style="border-color: var(--zip-border); background: var(--zip-surface)"
      @click="open = !open"
    >
      <span
        class="grid place-items-center w-28 h-28 rounded-full text-[12px] font-semibold"
        style="background: var(--zip-brand-soft); color: #1f7a45"
      >{{ initials }}</span>
      <span class="text-[14px] font-medium mobile:hidden">{{ demoConfig.lenderName }}</span>
    </button>

    <Transition name="zip-fade">
      <div
        v-if="open"
        class="zip-card absolute right-0 mt-8 w-240 p-8 z-50"
      >
        <div class="px-12 py-8">
          <p class="text-[14px] font-semibold">
            {{ demoConfig.lenderName }}
          </p>
          <p
            class="text-[12px]"
            style="color: var(--zip-text-muted)"
          >
            {{ demoConfig.lenderEmail }}
          </p>
        </div>
        <div class="zip-divider my-6" />
        <button
          v-for="item in [
            { label: 'Profile', to: '/zipcode/settings' },
            { label: 'Payment methods', to: '/zipcode/settings' },
            { label: 'Documents', to: '/zipcode/settings' },
          ]"
          :key="item.label"
          type="button"
          class="w-full text-left px-12 py-8 rounded-8 text-[14px] hover:bg-[color:var(--zip-surface-muted)]"
          @click="go(item.to)"
        >
          {{ item.label }}
        </button>
        <button
          v-if="flags.showAdvancedSettings"
          type="button"
          class="w-full text-left px-12 py-8 rounded-8 text-[14px] hover:bg-[color:var(--zip-surface-muted)]"
          @click="go('/zipcode/settings/advanced')"
        >
          Advanced settings
        </button>
        <div class="zip-divider my-6" />
        <button
          type="button"
          class="w-full text-left px-12 py-8 rounded-8 text-[14px] hover:bg-[color:var(--zip-surface-muted)]"
          @click="onReset"
        >
          Reset demo
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.zip-fade-enter-active,
.zip-fade-leave-active {
  transition: opacity 0.14s ease, transform 0.14s ease;
}
.zip-fade-enter-from,
.zip-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>

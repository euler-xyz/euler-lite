<script setup lang="ts">
type SwapRouteBadgeTone = 'best' | 'worse'

type SwapRouteItem = {
  provider: string
  amount: string
  symbol: string
  routeLabel?: string
  badge?: {
    label: string
    tone: SwapRouteBadgeTone
  }
}

const VISIBLE_COUNT = 3

const props = withDefaults(defineProps<{
  title?: string
  statusLabel?: string | null
  items: SwapRouteItem[]
  selectedProvider?: string | null
  isLoading?: boolean
  emptyMessage?: string
}>(), {
  title: 'Select swap route',
  statusLabel: null,
  selectedProvider: null,
  isLoading: false,
  emptyMessage: 'Enter amount to fetch quotes',
})

const emit = defineEmits<{
  (e: 'select', provider: string): void
  (e: 'refresh'): void
}>()

const expanded = ref(false)

const hasMore = computed(() => props.items.length > VISIBLE_COUNT)
const visibleItems = computed(() =>
  expanded.value ? props.items : props.items.slice(0, VISIBLE_COUNT),
)

const onSelect = (provider: string) => {
  emit('select', provider)
}
</script>

<template>
  <div
    class="flex justify-between items-center"
    data-id="swap-route-list-header"
    :data-count="items.length"
    :data-rendered-count="visibleItems.length"
  >
    <p class="text-h4 text-content-primary">
      {{ title }}
    </p>
    <div class="flex items-center gap-8">
      <p class="text-p3 text-content-secondary">
        {{ statusLabel || '-' }}
      </p>
      <button
        type="button"
        aria-label="Refresh swap quotes"
        class="text-content-secondary hover:text-accent-600 transition-colors disabled:opacity-50"
        :disabled="isLoading || !items.length"
        @click="emit('refresh')"
      >
        <SvgIcon
          name="refresh"
          class="!w-16 !h-16"
          :class="{ 'animate-spin': isLoading }"
        />
      </button>
    </div>
  </div>
  <div
    class="bg-surface-secondary p-16 rounded-16 flex flex-col gap-12 border border-line-default"
    data-id="swap-route-list"
    :data-count="items.length"
    :data-rendered-count="visibleItems.length"
  >
    <div class="flex flex-col gap-8">
      <template v-if="items.length">
        <div
          class="flex flex-col gap-8"
          :class="{
            'mobile:max-h-[max(168px,min(320px,calc(100dvh-360px)))] mobile:overflow-y-auto mobile:overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden': expanded && hasMore,
          }"
        >
          <button
            v-for="item in visibleItems"
            :key="item.provider"
            type="button"
            class="w-full text-left rounded-12 border p-12 transition-colors"
            data-id="swap-route-list-item"
            :data-key="item.provider"
            :data-provider="item.provider"
            :data-selected="selectedProvider === item.provider"
            :class="selectedProvider === item.provider
              ? 'border-accent-500 bg-neutral-200'
              : 'border-line-default bg-surface hover:bg-surface-secondary'"
            @click="onSelect(item.provider)"
          >
            <div class="flex items-center justify-between gap-8">
              <p
                class="text-p2 text-content-primary"
                data-id="data-point"
                :data-key="item.provider"
                data-field="swap-route-amount"
                :data-value="item.amount"
              >
                {{ item.amount }} {{ item.symbol }}
              </p>
              <div class="flex flex-col items-end gap-2 text-p3 text-content-secondary">
                <p
                  v-if="item.badge"
                  :class="item.badge.tone === 'best' ? 'text-success-600' : 'text-error-500'"
                  data-id="data-point"
                  :data-key="item.provider"
                  data-field="swap-route-badge"
                  :data-value="item.badge.label"
                >
                  {{ item.badge.label }}
                </p>
                <span
                  class="truncate"
                  data-id="data-point"
                  :data-key="item.provider"
                  data-field="swap-route-label"
                  :data-value="item.routeLabel || '-'"
                >{{ item.routeLabel || '-' }}</span>
              </div>
            </div>
          </button>
        </div>
        <button
          v-if="hasMore"
          type="button"
          class="flex items-center justify-center gap-4 text-p3 text-content-secondary hover:text-content-primary transition-colors py-4"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          <span>{{ expanded ? 'Show less' : `Show all ${items.length} quotes` }}</span>
          <SvgIcon
            name="arrow-down"
            class="!w-14 !h-14 transition-transform"
            :class="{ 'rotate-180': expanded }"
          />
        </button>
      </template>
      <template v-else-if="isLoading">
        <div class="h-48 rounded-12 bg-surface animate-pulse" />
        <div class="h-48 rounded-12 bg-surface animate-pulse" />
        <div class="h-48 rounded-12 bg-surface animate-pulse" />
      </template>
      <template v-else>
        <p class="text-p3 text-content-secondary">
          {{ emptyMessage }}
        </p>
      </template>
    </div>
  </div>
</template>

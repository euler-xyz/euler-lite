<script setup lang="ts">
import type {
  ActivityCategory,
} from '@eulerxyz/euler-v2-sdk'
import type { ActivityFeedScope } from '~/composables/useActivityFeed'
import {
  getActivityCategoryLabel,
  isActivityScopeUnsupported,
  resolveActivityFilterCategories,
  type ActivityFilterOption,
} from '~/utils/activity-display'

const props = defineProps<{
  scope: ActivityFeedScope
  enabled: boolean
  categoryOptions: readonly ActivityFilterOption[]
}>()
const emit = defineEmits<{
  'settled': []
  'update:unsupported': [unsupported: boolean]
}>()

const selectedFilters = ref<string[]>([])
const selectedCategories = computed<ActivityCategory[]>(() =>
  resolveActivityFilterCategories(props.categoryOptions, selectedFilters.value),
)
const feed = useActivityFeed({
  scope: () => props.scope,
  enabled: () => props.enabled,
  categories: selectedCategories,
})

const missingCategoryLabels = computed(() =>
  feed.coverage.value?.missingCategories
    ?.map(getActivityCategoryLabel)
    .join(', '),
)
const partialMessage = computed(() => {
  if (feed.coverage.value?.reason) return feed.coverage.value.reason
  if (missingCategoryLabels.value) return `Missing categories: ${missingCategoryLabels.value}.`
  return 'Some activity may not be included yet.'
})
const scopeUnsupported = computed(() =>
  isActivityScopeUnsupported(feed.coverage.value?.status, selectedFilters.value),
)

watch(
  () => props.categoryOptions.map(option => option.value),
  (available) => {
    selectedFilters.value = selectedFilters.value.filter(filter => available.includes(filter))
  },
)

watch(scopeUnsupported, unsupported => emit('update:unsupported', unsupported), {
  immediate: true,
})

watch(feed.hasLoaded, (hasLoaded) => {
  if (hasLoaded) emit('settled')
})
</script>

<template>
  <div class="flex flex-col gap-16">
    <ActivityCategoryFilters
      v-model="selectedFilters"
      :options="categoryOptions"
    />

    <div
      v-if="feed.isPartial.value"
      class="flex items-start gap-8 rounded-12 bg-warning-100 p-12 text-p4 text-warning-500"
    >
      <SvgIcon
        name="warning"
        class="!h-18 !w-18 shrink-0"
        aria-hidden="true"
      />
      <span>{{ partialMessage }}</span>
    </div>

    <div
      v-if="feed.isSyncing.value"
      class="flex items-start gap-8 rounded-12 bg-surface p-12 text-p4 text-content-secondary"
    >
      <SvgIcon
        name="refresh"
        class="!h-18 !w-18 shrink-0"
        aria-hidden="true"
      />
      <span>{{ feed.coverage.value?.reason || 'Activity indexing is catching up. Recent events may appear shortly.' }}</span>
    </div>

    <div
      v-if="feed.hasStaleError.value"
      class="flex items-center gap-8 rounded-12 bg-warning-100 p-12 text-p4 text-warning-500"
    >
      <SvgIcon
        name="warning"
        class="!h-18 !w-18 shrink-0"
        aria-hidden="true"
      />
      <span class="flex-1">Activity could not be refreshed. Showing the last loaded events.</span>
      <button
        type="button"
        class="font-medium underline hover:no-underline"
        :disabled="feed.isRefreshing.value"
        @click="feed.refresh"
      >
        Retry
      </button>
    </div>

    <div
      v-if="feed.isLoading.value"
      class="flex flex-col gap-8"
      aria-label="Loading activity"
    >
      <div
        v-for="index in 3"
        :key="index"
        class="h-72 animate-pulse rounded-12 bg-surface"
      />
    </div>

    <div
      v-else-if="feed.hasColdError.value"
      class="flex flex-col items-center gap-12 rounded-12 border border-line-subtle bg-surface p-24 text-center"
    >
      <div class="text-p3 text-content-primary">
        Activity could not be loaded right now.
      </div>
      <button
        type="button"
        class="ui-button ui-button--medium ui-button--secondary"
        @click="feed.refresh"
      >
        Retry
      </button>
    </div>

    <div
      v-else-if="feed.isUnsupported.value"
      class="rounded-12 border border-line-subtle bg-surface p-16 text-p3 text-content-secondary"
    >
      {{ selectedFilters.length ? 'Activity is not available for the selected categories.' : feed.coverage.value?.reason || 'Activity is not available for this vault.' }}
    </div>

    <div
      v-else-if="feed.isSyncing.value && feed.events.value.length === 0"
      class="rounded-12 border border-line-subtle bg-surface p-16 text-p3 text-content-secondary"
    >
      No indexed activity is available yet.
    </div>

    <div
      v-else-if="feed.isPartial.value && feed.events.value.length === 0"
      class="rounded-12 border border-line-subtle bg-surface p-16 text-p3 text-content-secondary"
    >
      No activity is available from the indexed sources. This history may be incomplete.
    </div>

    <div
      v-else-if="feed.isEmpty.value"
      class="rounded-12 border border-line-subtle bg-surface p-16 text-p3 text-content-secondary"
    >
      {{ selectedFilters.length ? 'No activity matches the selected categories.' : 'No activity has been indexed for this vault yet.' }}
    </div>

    <template v-else-if="feed.events.value.length">
      <div
        class="transition-opacity"
        :class="{ 'opacity-60': feed.isRefreshing.value }"
      >
        <div class="hidden grid-cols-[minmax(0,1.3fr)_minmax(180px,1fr)_minmax(160px,0.8fr)_40px] gap-12 border-b border-line-subtle pb-8 text-p4 text-content-tertiary laptop:grid">
          <span>Event</span>
          <span>Details</span>
          <span>Participants</span>
          <span class="sr-only">Transaction</span>
        </div>
        <ul>
          <ActivityEventRow
            v-for="event in feed.events.value"
            :key="event.id"
            :event="event"
          />
        </ul>
      </div>

      <div
        v-if="feed.loadMoreError.value"
        class="flex items-center gap-8 rounded-12 bg-warning-100 p-12 text-p4 text-warning-500"
      >
        <span class="flex-1">Older activity could not be loaded.</span>
        <button
          type="button"
          class="font-medium underline hover:no-underline"
          @click="feed.loadMore"
        >
          Retry
        </button>
      </div>

      <button
        v-if="feed.hasMore.value"
        type="button"
        class="ui-button ui-button--medium ui-button--secondary self-center"
        :disabled="feed.isLoadingMore.value"
        @click="feed.loadMore"
      >
        {{ feed.isLoadingMore.value ? 'Loading…' : 'Load older' }}
      </button>
    </template>
  </div>
</template>

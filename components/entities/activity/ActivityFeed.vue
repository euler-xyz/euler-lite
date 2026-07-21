<script setup lang="ts">
import type {
  ActivityCategory,
} from '@eulerxyz/euler-v2-sdk'
import type { ActivityFeedScope } from '~/composables/useActivityFeed'
import { getExplorerLink } from '~/utils/block-explorer'
import {
  formatActivityRelativeTimestamp,
  formatActivityTimestamp,
  getActivityCategoryLabel,
  groupActivityEventsByTransaction,
  isActivityScopeUnsupported,
  resolveActivityFilterCategories,
  type ActivityFilterOption,
} from '~/utils/activity-display'

const props = withDefaults(defineProps<{
  scope: ActivityFeedScope
  enabled: boolean
  categoryOptions: readonly ActivityFilterOption[]
  subject?: 'account' | 'vault'
}>(), {
  subject: 'vault',
})
const emit = defineEmits<{
  'settled': []
  'update:unsupported': [unsupported: boolean]
}>()

const selectedFilters = ref<string[]>([])
const selectedCategories = computed<ActivityCategory[]>(() =>
  resolveActivityFilterCategories(props.categoryOptions, selectedFilters.value),
)
const activityNowMs = useActivityNowMs()
const scopeLabel = computed(() => props.subject === 'account' ? 'account' : 'vault')
// Coverage is complete here — the account/vault genuinely has no events, so
// don't blame indexing. Accounts mention the network since switching chains
// is the usual reason a wallet's history looks empty.
const emptyMessage = computed(() => props.subject === 'account'
  ? 'No activity for this account on this network yet.'
  : 'No activity for this vault yet.')
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
  if (missingCategoryLabels.value) return `${missingCategoryLabels.value} activity may be incomplete.`
  return 'Some activity may not be included yet.'
})
const scopeUnsupported = computed(() =>
  isActivityScopeUnsupported(feed.coverage.value?.status, selectedFilters.value),
)
// When the active filter narrows the feed to a single category, the rows'
// category label would just restate the selected chip.
const impliedCategory = computed(() =>
  selectedCategories.value.length === 1 ? selectedCategories.value[0] : undefined,
)
const COLLAPSED_GROUP_EVENT_COUNT = 3
const expandedGroupIds = ref(new Set<string>())
const eventGroups = computed(() => props.subject === 'account'
  ? groupActivityEventsByTransaction(feed.events.value)
  : feed.events.value.map(event => ({
      id: event.id,
      chainId: event.chainId,
      txHash: event.txHash,
      timestamp: event.timestamp,
      events: [event],
    })),
)
const isGroupExpanded = (groupId: string) => expandedGroupIds.value.has(groupId)
const visibleGroupEvents = (group: (typeof eventGroups.value)[number]) =>
  group.events.length > COLLAPSED_GROUP_EVENT_COUNT && !isGroupExpanded(group.id)
    ? group.events.slice(0, COLLAPSED_GROUP_EVENT_COUNT)
    : group.events
const toggleGroup = (groupId: string) => {
  const next = new Set(expandedGroupIds.value)
  if (next.has(groupId)) next.delete(groupId)
  else next.add(groupId)
  expandedGroupIds.value = next
}

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
  <div class="activity-feed flex flex-col gap-16">
    <ActivityCategoryFilters
      v-if="categoryOptions.length > 1"
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
      {{ selectedFilters.length ? 'Activity is not available for the selected categories.' : feed.coverage.value?.reason || `Activity is not available for this ${scopeLabel}.` }}
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
      {{ selectedFilters.length ? 'No activity matches the selected categories.' : emptyMessage }}
    </div>

    <template v-else-if="feed.events.value.length">
      <div
        class="transition-opacity"
        :class="{ 'opacity-60': feed.isRefreshing.value }"
      >
        <div class="activity-feed__header hidden gap-16 border-b border-line-subtle pb-8 text-p4 text-content-tertiary">
          <span class="activity-feed__header-event">Event</span>
          <span>Amount / change</span>
          <span class="sr-only">Transaction</span>
        </div>
        <div>
          <section
            v-for="group in eventGroups"
            :key="group.id"
            :class="group.events.length > 1 ? 'my-8 rounded-12 border border-line-subtle bg-surface px-12' : ''"
          >
            <div
              v-if="group.events.length > 1"
              class="flex items-center justify-between gap-12 border-b border-line-subtle py-10 pl-44 text-p4 text-content-tertiary"
            >
              <div class="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
                <span class="font-medium text-content-secondary">Transaction</span>
                <span aria-hidden="true">&middot;</span>
                <time
                  :datetime="group.timestamp"
                  :title="formatActivityTimestamp(group.timestamp)"
                >{{ formatActivityRelativeTimestamp(group.timestamp, activityNowMs) }}</time>
                <span aria-hidden="true">&middot;</span>
                <span>{{ group.events.length }} events</span>
              </div>
              <a
                :href="getExplorerLink(group.txHash, group.chainId)"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex h-32 w-32 items-center justify-center rounded-8 text-content-secondary transition-colors hover:bg-card-hover hover:text-accent-500"
                aria-label="View grouped transaction"
                title="View transaction"
              >
                <SvgIcon
                  name="arrow-top-right"
                  class="!h-16 !w-16"
                  aria-hidden="true"
                />
              </a>
            </div>
            <ul>
              <ActivityEventRow
                v-for="event in visibleGroupEvents(group)"
                :key="event.id"
                :event="event"
                :show-vault="subject === 'account'"
                :viewer-address="scope.kind === 'account' ? scope.owner : undefined"
                :hide-category="subject === 'account'"
                :hide-timestamp="group.events.length > 1"
                :grouped="group.events.length > 1"
                :hidden-category="impliedCategory"
                :show-transaction-link="group.events.length === 1"
                :now-ms="activityNowMs"
              />
            </ul>
            <button
              v-if="group.events.length > COLLAPSED_GROUP_EVENT_COUNT"
              type="button"
              class="flex w-full items-center justify-center gap-4 border-t border-line-subtle py-10 text-p4 font-medium text-content-secondary transition-colors hover:text-content-primary"
              :aria-expanded="isGroupExpanded(group.id)"
              @click="toggleGroup(group.id)"
            >
              <span>
                {{ isGroupExpanded(group.id)
                  ? 'Show fewer events'
                  : `Show ${group.events.length - COLLAPSED_GROUP_EVENT_COUNT} more events` }}
              </span>
              <SvgIcon
                name="arrow-down"
                class="!h-12 !w-12 transition-transform"
                :class="{ 'rotate-180': isGroupExpanded(group.id) }"
                aria-hidden="true"
              />
            </button>
          </section>
        </div>
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

<style scoped>
.activity-feed {
  container-name: activity-feed;
  container-type: inline-size;
}

@container activity-feed (min-width: 900px) {
  .activity-feed__header {
    display: grid;
    grid-template-columns:
      32px
      minmax(280px, 1fr)
      minmax(320px, 1.2fr)
      44px;
  }

  /* Skip the icon column so the label aligns with the event titles. */
  .activity-feed__header-event {
    grid-column: 2;
  }
}
</style>

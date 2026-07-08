<script setup lang="ts">
import { isExternalMigrationDustPosition, type ExternalMigrationCandidate } from '~/composables/useExternalMigrationPositions'

defineOptions({
  name: 'PortfolioMigratePage',
})

const route = useRoute()
const router = useRouter()
const migratingPositionId = ref('')
const {
  positions,
  isLoading,
  error,
  hasLoaded,
  load,
} = useExternalMigrationPositions()

const visiblePositions = computed(() =>
  positions.value.filter(position => !isExternalMigrationDustPosition(position)),
)

const disabledReason = (position: ExternalMigrationCandidate) => {
  return position.disabledReason ?? ''
}

const liveStatus = computed(() => {
  if (isLoading.value) return 'Scanning Aave and Morpho'
  if (error.value) return 'Migration scan failed'
  if (hasLoaded.value) return `${visiblePositions.value.length} migration positions available`
  return ''
})

const migrate = async (position: ExternalMigrationCandidate) => {
  if (disabledReason(position) || migratingPositionId.value) return
  migratingPositionId.value = position.id
  try {
    await router.push({
      path: '/position/external/borrow/swap',
      query: {
        network: route.query.network,
        source: position.id,
      },
    })
  }
  catch {
    migratingPositionId.value = ''
  }
}

onActivated(() => {
  // The page is kept alive: returning from the migration flow restores this
  // instance, so clear the pending state or the clicked row spins forever
  // (and the guard in migrate() blocks every other row).
  migratingPositionId.value = ''
  if (hasLoaded.value) void load({ force: true })
})
</script>

<template>
  <div class="portfolio-migrate mx-16">
    <div
      class="sr-only"
      aria-live="polite"
    >
      {{ liveStatus }}
    </div>

    <div class="portfolio-migrate__heading">
      <h3 class="portfolio-migrate__title">
        Migrate to Euler
      </h3>
    </div>

    <div class="flex flex-1 p-8 rounded-12 border border-line-default bg-card">
      <div
        v-if="isLoading && visiblePositions.length === 0"
        class="flex flex-1 justify-center items-center"
      >
        <UiLoader class="text-neutral-500 my-8" />
      </div>

      <div
        v-else-if="error"
        class="portfolio-migrate__error"
      >
        <div>
          <div class="portfolio-migrate__error-title">
            Could not scan external positions
          </div>
          <div class="portfolio-migrate__error-text">
            {{ error }}
          </div>
        </div>
        <button
          type="button"
          class="portfolio-migrate__retry"
          @click="() => load({ force: true })"
        >
          Retry
        </button>
      </div>

      <div
        v-else
        class="portfolio-migrate__list flex-1"
      >
        <PortfolioMigrateRow
          v-for="position in visiblePositions"
          :key="position.id"
          :position="position"
          :loading="migratingPositionId === position.id"
          :disabled-reason="disabledReason(position)"
          :show-action="true"
          @migrate="migrate(position)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.portfolio-migrate {
  display: flex;
  flex-direction: column;
  gap: 12px;

  &__heading {
    margin-bottom: 4px;
  }

  &__title {
    color: var(--text-primary);
    font-size: 17px;
    line-height: 24px;
    font-weight: 500;
  }

  &__list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  &__error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 132px;
    padding: 16px;
    border: 1px solid var(--border-default);
    border-radius: 12px;
    background: var(--bg-surface);
    box-shadow: var(--shadow-card);
  }

  &__error-title {
    color: var(--text-primary);
    font-size: 13px;
    line-height: 18px;
  }

  &__error-text {
    margin-top: 2px;
    color: var(--text-tertiary);
    font-size: 12px;
    line-height: 18px;
  }

  &__retry {
    color: var(--accent-600);
    font-size: 13px;
    line-height: 18px;
    white-space: nowrap;
  }
}

@media (max-width: 767px) {
  .portfolio-migrate {
    &__error {
      align-items: flex-start;
      flex-direction: column;
    }
  }
}

@keyframes shimmer {
  0% {
    background-position: 100% 0;
  }

  100% {
    background-position: -100% 0;
  }
}
</style>

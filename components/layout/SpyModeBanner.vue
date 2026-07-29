<script setup lang="ts">
const { isSpyMode, isSpyResolving, spyShortAddress, spyAddress, clearSpyMode } = useSpyMode()
</script>

<template>
  <div
    v-if="isSpyMode"
    class="spy-banner"
  >
    <div class="flex items-center gap-8">
      <UiIcon
        name="search-user"
        class="!w-16 !h-16"
      />
      <!-- The candidate address is never displayed until its owner resolves. -->
      <span
        v-if="isSpyResolving"
        class="text-p3"
      >
        Verifying address…
      </span>
      <span
        v-else
        class="text-p3"
      >
        Viewing as
        <UiHoverPreviewTooltip
          title="Spy address"
          :text="spyAddress"
          placement="top-start"
        >
          <span>{{ spyShortAddress }}</span>
        </UiHoverPreviewTooltip>
      </span>
    </div>
    <button
      type="button"
      class="spy-banner-exit"
      @click="clearSpyMode"
    >
      Exit
    </button>
  </div>
</template>

<style scoped lang="scss">
.spy-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 16px;
  background-color: var(--accent-300);
  color: var(--text-inverse);
  font-size: 14px;
  line-height: 20px;
}

.spy-banner-exit {
  padding: 2px 10px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  background-color: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  cursor: pointer;
  transition: background-color 0.15s;

  &:hover {
    background-color: var(--bg-surface-secondary);
  }
}
</style>

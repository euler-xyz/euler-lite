<script setup lang="ts">
const emits = defineEmits<{
  (e: 'click'): void
}>()
const props = defineProps<{
  active: boolean
  pill?: boolean
  icon?: string
  badge?: unknown
  disabled?: boolean
}>()

const classes = computed(() => ({
  'is-active': props.active,
  'is-disabled': props.disabled,
  'is-pill': props.pill,
  'is-badge': props.badge,
}))

const onClick = () => {
  if (!props.disabled) {
    emits('click')
  }
}
</script>

<template>
  <button
    :class="classes"
    class="ui-tab"
    type="button"
    @click="onClick"
  >
    <SvgIcon
      v-if="icon"
      class="ui-tab__icon"
      :name="icon"
    />
    <slot />
    <div
      v-if="badge"
      class="ui-tab__badge"
    >
      {{ badge }}
    </div>
  </button>
</template>

<style lang='scss'>
.ui-tab {
  display: inline-flex;
  gap: 10px;
  align-items: center;
  justify-content: center;
  min-height: 56px;
  padding: 0 16px;
  outline: none;
  font-size: 16px;
  line-height: 20px;
  font-weight: 400;
  text-align: center;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  box-shadow: inset 0em -2px 0 transparent;
  color: var(--ui-tab-text-color);
  transition: color 0.15s ease;

  &__icon {
    margin-right: 8px;
  }

  &__badge {
    font-size: 12px;
    font-weight: 600;
    line-height: 20px;
    padding: 1px 6px;
    background-color: var(--ui-tab-badge-background-color);
    border-radius: 0;
  }

  &.is-active {
    box-shadow: inset 0 -2px 0 -1px var(--ui-tab-active-box-shadow-color);
    color: var(--ui-tab-active-text-color);
    font-weight: 500;
  }

  &.is-pill {
    min-height: 44px;

    &:hover {
      box-shadow: none;
    }

    &.is-active {
      box-shadow: none;
    }
  }

  &.is-badge {
    padding: 0 12px;
  }
}
</style>

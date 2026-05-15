<script lang="ts">
export type UiTab = {
  label: string
  value: string | number | undefined
  icon?: string
  disabled?: boolean
  class?: string
  badge?: unknown
  [key: string]: unknown
}
</script>

<script setup lang="ts" generic="T extends UiTab">
const model = defineModel<string | number>({})
const props = defineProps<{
  list: T[]
  label?: string
  rounded?: boolean
  pills?: boolean
}>()

let resizeObserver: ResizeObserver | null

const scrollableRef = ref()
const listRef = ref()
const blockStyles = reactive({
  transform: 'translate3d(0, 0, 0)',
  width: 'auto',
})
const scrollPosition = ref(0)
const maxPosition = ref(0)
const showRightGradient = computed(() => {
  if (maxPosition.value <= 0) {
    return false
  }
  return scrollPosition.value < maxPosition.value - 1
})

const currentIdx = computed(() => {
  return props.list.findIndex((item: UiTab) => item.value === model.value)
})
const classes = computed(() => {
  return {
    'is-rounded': props.rounded,
    'is-pills': props.pills,
  }
})

const updateBlockStyles = () => {
  if (!listRef.value) {
    return
  }
  const query = props.pills ? '.ui-tabs__tab' : '.ui-tabs__tab-text'
  const el = listRef.value ? listRef.value.querySelectorAll(query)[currentIdx.value] : undefined

  if (!el) {
    blockStyles.transform = 'translate3d(0, 0, 0)'
    blockStyles.width = 'auto'
  }

  if (el) {
    const width = Math.floor(el.getBoundingClientRect().width)
    const left = el.offsetLeft + (el.clientWidth / 2)

    blockStyles.transform = `translate3d(calc(${left}px - 50%), 0, 0)`
    blockStyles.width = `${width}px`
    checkScrollPosition()
    return
  }

  blockStyles.transform = 'translate3d(0, 0, 0)'
  blockStyles.width = 'auto'
  checkScrollPosition()
}
const checkActive = (item: UiTab) => {
  return (!model.value && !item.value) || (model.value === item.value)
}
const checkScrollPosition = () => {
  const scrollLeft = scrollableRef.value?.scrollLeft || 0
  const scrollWidth = scrollableRef.value?.scrollWidth || 0
  const offsetWidth = scrollableRef.value?.offsetWidth || 0
  scrollPosition.value = scrollLeft
  maxPosition.value = scrollWidth - offsetWidth
}
const onSelect = (value: string | number | undefined, index: number) => {
  model.value = value

  const el = listRef.value ? listRef.value.querySelectorAll('.ui-tabs__item')[index] : undefined
  if (el) {
    const isOutside = el.offsetLeft < scrollableRef.value.scrollLeft
      || el.offsetLeft + el.offsetWidth > scrollableRef.value.scrollLeft + scrollableRef.value.clientWidth
    const offset = props.pills && index === 0 ? -4 : -20
    scrollableRef.value.scroll({
      left: isOutside ? el.offsetLeft + offset : undefined,
      top: 0,
      behavior: 'smooth',
    })
  }
}

watch(currentIdx, () => {
  updateBlockStyles()
})
watch(() => props.list.length, async () => {
  await nextTick()
  checkScrollPosition()
})

onMounted(() => {
  resizeObserver = new ResizeObserver(updateBlockStyles)
  resizeObserver.observe(listRef.value)
  checkScrollPosition()
})
onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.unobserve(listRef.value)
    resizeObserver = null
  }
})

defineExpose({
  scrollableRef,
})
</script>

<template>
  <div
    class="ui-tabs"
    :class="classes"
  >
    <div
      ref="scrollableRef"
      class="ui-tabs__wrapper"
      @scroll="checkScrollPosition"
    >
      <ul
        ref="listRef"
        class="ui-tabs__list"
        role="tablist"
        :aria-label="label"
      >
        <li
          v-for="(item, idx) in list"
          :key="idx"
          class="ui-tabs__item"
          :class="item.class"
          data-id="tab"
          :data-key="String(item.value ?? 'default')"
          data-field="tab"
          :data-value="item.label"
          role="tab"
          :aria-selected="checkActive(item)"
          aria-expanded="true"
        >
          <UiTab
            class="ui-tabs__tab"
            :active="checkActive(item)"
            :disabled="item.disabled"
            :pill="pills"
            :icon="item.icon"
            :badge="item.badge"
            @click="onSelect(item.value, idx)"
          >
            <span class="ui-tabs__tab-text">
              <slot :tab="item">
                {{ item.label || item.value }}
              </slot>
            </span>
          </UiTab>
        </li>
      </ul>

      <span
        class="ui-tabs__block"
        :style="blockStyles"
      />
    </div>
    <span
      v-if="showRightGradient"
      class="ui-tabs__gradient ui-tabs__gradient--right"
    />
  </div>
</template>

<style lang="scss">
.ui-tabs {
  position: relative;
  $block: &;
  border-radius: 16px;
  --ui-tabs-gradient-color: rgba(0, 0, 0, 0.35);

  &.is-rounded {
    #{$block}__list {
      width: 100%;
    }

    #{$block}__item {
      flex-grow: 1;
      flex-shrink: 1;
      flex-basis: 100%;
    }
  }

  &.is-pills {
    --ui-tabs-gradient-color: var(--ui-tabs-pills-background-color);

    #{$block}__wrapper {
      box-shadow: none;
      background-color: var(--ui-tabs-pills-background-color);
      border-radius: 12px;
      padding: 4px 0;
      border-bottom: none;
    }

    #{$block}__list {
      width: 100%;

      &:before, &:after {
        content: '';
        display: inline-block;
        flex-shrink: 0;
        width: 4px;
      }
    }

    #{$block}__item {
      flex-grow: 1;
      flex-shrink: 1;
      flex-basis: 100%;
    }

    #{$block}__block {
      min-height: 44px;
      background-color: var(--ui-tabs-block-background-color);
      border-radius: 12px 12px 0 0;
      border-bottom: 2px solid var(--accent-600);
      width: auto;
      bottom: auto;
      max-width: none;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }
  }

  &__wrapper {
    position: relative;
    display: flex;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  &__list {
    display: flex;
  }

  &__item {
    z-index: 2;
  }

  &__tab {
    width: 100%;
  }

  &__block {
    position: absolute;
    bottom: 0;
    left: 0;
    z-index: 0;
    display: block;
    height: 3px;
    width: 34px;
    max-width: 34px;
    border-radius: 10px 10px 0 0;
    will-change: width, transform;
    transition: transform var(--trs-default), width var(--trs-default);
  }

  &__gradient {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 32px;
    z-index: 3;
    pointer-events: none;

    &--right {
      right: 0;
      background: linear-gradient(90deg, rgba(0, 0, 0, 0), var(--ui-tabs-gradient-color));
    }
  }
}
</style>

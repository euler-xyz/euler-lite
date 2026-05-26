<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core'

const {
  min = 0,
  max = 100,
  step = 10,
  label,
  hideSteps,
  numberFilter = (n: number) => {
    return `${n}`
  },
} = defineProps<{
  min?: number
  max?: number
  step?: number
  label?: string
  hideSteps?: boolean
  numberFilter?: (n: number) => string
}>()
const model = defineModel<number>({ default: 0 })

let xOffset: number = 0
let trackBox: DOMRect | undefined

const trackEl = useTemplateRef<HTMLElement>('trackEl')
const isDragging = ref(false)

const styles = reactive({
  trackActive: {
    width: `0px`,
  },
  thumb: {
    transform: `translate(0px, -50%)`,
  },
})

const roundTick = (value: number) => Math.round(value * 100) / 100
const ticks = computed(() => {
  const range = max - min
  return [
    roundTick(min),
    roundTick(min + range * 0.25),
    roundTick(min + range * 0.5),
    roundTick(min + range * 0.75),
    roundTick(max),
  ]
})
const invStep = computed(() => 1.0 / step)

const update = (x: number) => {
  const p = x / trackBox!.width
  const v = p * (max - min) + min
  model.value = min + Math.round((v - min) * invStep.value) / invStep.value
}
const render = async () => {
  await nextTick()
  if (!trackBox) {
    return
  }
  const x = ((model.value - min) / (max - min)) * trackBox.width
  const thumbX = Math.max(0, Math.min(x - 10, trackBox.width - 20))
  styles.trackActive.width = `${thumbX + 10}px`
  styles.thumb.transform = `translate(${thumbX}px, -50%)`
}
const onPointerDown = () => {
  if (!trackBox && trackEl.value) {
    trackBox = trackEl.value.getBoundingClientRect()
  }

  xOffset = trackBox?.left || 0
  isDragging.value = true
}
const onPointerMove = (e: PointerEvent) => {
  if (isDragging.value) {
    update(Math.max(0, Math.min(e.clientX - xOffset, trackBox!.width)))
  }
}
const onPointerUp = () => {
  isDragging.value = false
}
const onClickTrack = (e: MouseEvent) => {
  if (isDragging.value || !trackBox) {
    return
  }

  const x = e.clientX - trackBox.x
  if (x < 0 || x > trackBox.width) {
    return
  }
  update(x)
}

watch(isDragging, () => {
  if (isDragging.value) {
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    return
  }

  document.removeEventListener('pointermove', onPointerMove)
  document.removeEventListener('pointerup', onPointerUp)
})

onMounted(() => {
  trackBox = trackEl.value?.getBoundingClientRect()
  render()
})

useResizeObserver(trackEl, () => {
  trackBox = trackEl.value?.getBoundingClientRect()
  render()
})

watch(model, () => {
  render()
})
</script>

<template>
  <div
    class="ui-range"
    data-id="ui-range"
    :data-label="label ?? ''"
    :data-value="String(model)"
    :data-min="String(min)"
    :data-max="String(max)"
    :data-step="String(step)"
  >
    <div
      v-if="label"
      class="ui-range__top"
    >
      {{ label }}

      <div class="ui-range__value">
        {{ numberFilter(model) }}
      </div>
    </div>

    <div class="ui-range__wrap">
      <div
        ref="trackEl"
        data-id="ui-range-track"
        :data-label="label ?? ''"
        class="ui-range__track"
        @click="onClickTrack"
      >
        <div
          class="ui-range__track-active"
          :style="styles.trackActive"
        />
        <div
          class="ui-range__thumb"
          :style="styles.thumb"
          @pointerdown="onPointerDown"
        />
      </div>
      <div
        v-if="!hideSteps"
        class="ui-range__steps"
      >
        <div
          v-for="(tick, idx) in ticks"
          :key="`step-${idx}`"
          data-id="ui-range-step"
          :data-label="label ?? ''"
          :data-value="String(tick)"
          class="ui-range__step"
          @click="model = tick; render()"
        >
          {{ numberFilter(tick) }}
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss">
.ui-range {
  user-select: none;
  touch-action: none;

  &__top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    font-size: 18px;
    line-height: 24px;
    font-weight: 600;
  }

  &__value {
    font-size: 14px;
    line-height: 20px;
    padding: 6px 10px;
    border-radius: 8px;
    background-color: var(--ui-range-value-background-color);
  }

  &__wrap {
    margin: -16px;
    padding: 16px;
    overflow: hidden;
  }

  &__track {
    position: relative;
    height: 6px;
    border-radius: 4px;
    background-color: var(--ui-range-track-background-color);
    cursor: pointer;
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.08);
  }

  &__track-active {
    height: inherit;
    border-radius: inherit;
    background-color: var(--ui-range-track-active-background-color);
  }

  &__thumb {
    display: flex;
    align-items: center;
    justify-content: center;
    position: absolute;
    top: 50%;
    border-radius: 50%;
    transform: translate(-10px, -50%);
    width: 20px;
    height: 20px;
    background-color: var(--ui-range-thumb-background-color);
    cursor: pointer;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15), 0 1px 2px rgba(0, 0, 0, 0.1);
    transition: box-shadow 0.15s ease;

    &:hover {
      box-shadow: 0 3px 6px rgba(0, 0, 0, 0.2), 0 1px 3px rgba(0, 0, 0, 0.12);
    }

    &:before {
      content: "";
      position: absolute;
      width: 7px;
      height: 7px;
      box-shadow: 0 0 0 4px var(--ui-range-thumb-box-shadow-color);
      border-radius: 50%;
    }

     // hitbox
     &:after {
       content: "";
       position: absolute;
       width: 40px;
       height: 40px;
       //background-color: red;
       //opacity: 0.3;
     }
  }

  &__steps {
    display: flex;
    justify-content: space-between;
    margin-top: 12px;
    text-align: center;
  }

  &__step {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 0;
    font-size: 12px;
    line-height: 16px;
    color: var(--ui-range-step-color);
    cursor: pointer;

    &:nth-child(even) {
      font-size: 10px;
      color: var(--ui-range-step-even-color);
    }

    &:first-child {
      justify-content: start;
    }

    &:last-child {
      justify-content: end;
    }
  }
}
</style>

<script setup lang="ts">
const model = defineModel<unknown>({})
const props = defineProps<{
  name?: string
  label?: string
  selfValue: unknown
  error?: string
  disabled?: boolean
  large?: boolean
}>()

const isFocused = ref(false)
const radioRef = ref()

const isChecked = computed(() => props.selfValue === model.value)
const classes = computed(() => {
  return {
    'is-focused': isFocused.value,
    'is-checked': isChecked.value,
    'is-disabled': props.disabled,
    'ui-radio--large': props.large,
  }
})

const onFocus = () => {
  isFocused.value = true
}

const onBlur = () => {
  isFocused.value = false
}

const onInput = () => {
  model.value = props.selfValue
}

const onClick = () => {
  model.value = props.selfValue
}
</script>

<template>
  <div
    class="ui-radio"
    :class="classes"
  >
    <label
      ref="radioRef"
      class="ui-radio__wrap"
      :class="{ 'is-disabled': disabled }"
    >
      <span class="ui-radio__field">
        <input
          class="ui-radio__input"
          type="radio"
          :value="selfValue"
          :name="name"
          :disabled="disabled"
          :aria-checked="isChecked"
          :aria-disabled="disabled"
          @keydown.enter.stop.prevent="radioRef.click()"
          @focus="onFocus"
          @blur="onBlur"
          @input="onInput"
          @click="onClick"
        >
      </span>
      <!-- <span
        v-if="label || $slots.label"
        class="ui-radio__label"
      >
        <slot name="label">
          {{ label }}
        </slot>
      </span> -->
    </label>
  </div>
</template>

<style lang="scss">
.ui-radio {
  $block: &;
  padding: 4px;

  &:hover {
    &:not(.is-disabled) {
      #{$block}__field {
        background-color: var(--ui-radio-hover-background-color);

        &::after {
          background-color: var(--ui-radio-hover-checked-background-color);
        }
      }
    }
  }

  &.is-focused {
    #{$block}__field {
      outline: 2px solid var(--ui-radio-focus-outline-color);
    }
  }

  &.is-disabled {

    #{$block}__field {
      background-color: transparent;

      &::after {
        background-color: var(--ui-radio-disabled-checked-background-color);
      }
    }

    #{$block}__input {
      cursor: not-allowed;
    }

    #{$block}__label {
      cursor: not-allowed;
    }
  }

  &.is-checked {
    #{$block}__field {
      position: relative;

      .icon {
        display: none;
      }

      &::after {
        transform: scale(1);
      }
    }
  }

  &__wrap {
    display: flex;
    align-items: center;
    outline: none;
    user-select: none;
  }

  &__field {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    min-width: 22px;
    height: 22px;
    background-color: var(--ui-radio-field-background-color);
    border: 1.5px solid var(--ui-radio-field-border-color);
    border-radius: 50%;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;

    &::after {
      content: "";
      width: 12px;
      height: 12px;
      position: absolute;
      background-color: var(--ui-radio-checked-background-color);
      border-radius: 50%;
      transform: scale(0);
      transition: transform 0.15s ease;
      box-shadow: 0 1px 2px rgba(var(--accent-500-rgb), 0.3);
    }

    svg {
      width: 16px;
      height: 16px;
    }
  }

  // &__label {
  //   margin-left: 8px;
  //   color: var(--ui-primary-text-color);
  //   font-size: var(--ui-font-size);
  //   line-height: var(--ui-line-height);
  //   font-weight: var(--ui-font-weight);
  //   cursor: pointer;
  //   transition: color var(--ui-transition);
  // }

  &--large {
    #{$block}__field {
      width: 34px;
      min-width: 34px;
      height: 34px;

      &::after {
        width: 20px;
        height: 20px;
      }
    }
  }
}
</style>

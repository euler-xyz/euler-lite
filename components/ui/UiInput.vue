<script setup lang="ts">
const model = defineModel<string>()
const props = withDefaults(
  defineProps<{
    placeholder?: string
    label?: string
    helpText?: string
    type?: string
    inputMode?: 'none' | 'text' | 'decimal' | 'numeric' | 'tel' | 'search' | 'email' | 'url'
    disabled?: boolean
    error?: boolean
    fullWidth?: boolean
    name?: string
    id?: string
    icon?: string
    clearable?: boolean
    compact?: boolean
  }>(),
  {
    type: 'text',
    fullWidth: true,
  },
)

const inputRef = ref()
const uniqueId = computed(() => props.id || props.name || `input-${Math.random().toString(36).substr(2, 9)}`)

const showClear = computed(() => props.clearable && !!model.value)

const classes = computed(() => {
  return {
    'is-disabled': props.disabled,
    'is-error': props.error,
    'is-full-width': props.fullWidth,
    'is-compact': props.compact,
  }
})
</script>

<template>
  <div :class="['ui-input', classes]">
    <div
      v-if="icon"
      class="ui-input__icon-wrap"
      @click="inputRef.focus()"
    >
      <SvgIcon
        :name="icon"
        class="ui-input__icon"
      />
    </div>
    <input
      :id="uniqueId"
      ref="inputRef"
      v-model="model"
      :type="type"
      :inputmode="inputMode"
      :disabled="disabled"
      :name="name"
      :placeholder="placeholder"
      :aria-invalid="error"
      :aria-disabled="disabled"
      :class="['ui-input__field', icon && 'icon', showClear && 'has-clear']"
    >
    <div
      v-if="showClear"
      class="ui-input__clear"
      @click="model = ''"
    >
      <SvgIcon
        name="close"
        class="ui-input__clear-icon"
      />
    </div>
  </div>
</template>

<style lang="scss">
.ui-input {
  $block: &;

  display: flex;
  width: 100%;
  background-color: var(--ui-input-background-color);
  border: 1px solid var(--ui-input-border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--ui-input-shadow);
  transition: border-color var(--trs-fast), box-shadow var(--trs-fast);

  &:not(.is-full-width) {
    width: fit-content;
  }

  &:focus-within {
    border-color: var(--ui-input-focus-border-color);
    box-shadow: var(--ui-input-focus-shadow);
  }

  &__field {
    width: 100%;
    min-height: 44px;
    padding: 12px 16px;
    font-size: 16px;
    line-height: 20px;
    font-weight: 400;
    color: var(--ui-input-color);
    outline: none;
    transition: all var(--trs-fast);

    &.icon {
      padding: 12px 16px 12px 0px;
    }

    &::placeholder {
      color: var(--ui-input-placeholder-color);
    }

    &:-webkit-autofill,
    &:-webkit-autofill:hover,
    &:-webkit-autofill:focus {
      -webkit-text-fill-color: var(--ui-input-color);
      -webkit-box-shadow: 0 0 0px 1000px var(--ui-input-background-color) inset;
      transition: background-color 5000s ease-in-out 0s;
    }
  }

  &.is-error {
    border-color: var(--ui-input-error-border-color);
    box-shadow: var(--ui-input-error-shadow);

    #{$block}__help {
      color: var(--ui-input-error-color);
    }
  }

  &.is-disabled {
    box-shadow: none;

    #{$block}__label {
      color: var(--ui-input-disabled-color);
    }

    #{$block}__field {
      background-color: transparent;
      border-color: var(--ui-input-disabled-border-color);
      color: var(--ui-input-disabled-color);
      cursor: not-allowed;
    }
  }

  &.is-compact {
    border-radius: 0px;
    box-shadow: none;
    border-color: var(--border-subtle);

    #{$block}__field {
      min-height: 36px;
      padding: 8px 14px;
      font-size: 14px;
      line-height: 18px;
    }

    #{$block}__icon-wrap {
      width: 38px;
    }

    #{$block}__icon {
      width: 16px;
      height: 16px;
    }
  }

  &__icon-wrap {
    width: 50px;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  &__icon {
    width: 20px;
    height: 20px;
    color: var(--ui-input-placeholder-color);
  }

  &__clear {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 12px;
    cursor: pointer;
  }

  &__clear-icon {
    width: 16px;
    height: 16px;
    color: var(--ui-input-placeholder-color);
    transition: color var(--trs-fast);

    &:hover {
      color: var(--ui-input-color);
    }
  }

  &__field.has-clear {
    padding-right: 0;
  }
}
</style>

<script setup lang="ts">
const {
  as = 'span',
  icon,
  label,
  tone = 'neutral',
  size = 'small',
  block = false,
  nudge = false,
  title,
} = defineProps<{
  as?: 'button' | 'span'
  icon: string
  label: string
  tone?: 'neutral' | 'governance' | 'accent' | 'warn' | 'danger'
  size?: 'small' | 'large'
  block?: boolean
  nudge?: boolean
  title?: string
}>()

const emit = defineEmits<{ click: [event: MouseEvent | KeyboardEvent] }>()

const onKeydown = (event: KeyboardEvent) => {
  if (as === 'button') return
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  emit('click', event)
}
</script>

<template>
  <component
    :is="as"
    :type="as === 'button' ? 'button' : undefined"
    :role="as === 'span' ? 'button' : undefined"
    :tabindex="as === 'span' ? 0 : undefined"
    class="vault-metadata-tag"
    :class="[
      `vault-metadata-tag--${tone}`,
      `vault-metadata-tag--${size}`,
      {
        'vault-metadata-tag--block': block,
        'vault-metadata-tag--nudge': nudge,
      },
    ]"
    :title="title"
    @click="$emit('click', $event)"
    @keydown="onKeydown"
  >
    <SvgIcon
      :name="icon"
      class="vault-metadata-tag__icon"
    />
    <span class="vault-metadata-tag__label">{{ label }}</span>
    <span class="vault-metadata-tag__spacer" />
    <SvgIcon
      name="info-circle"
      class="vault-metadata-tag__info"
    />
  </component>
</template>

<style scoped lang="scss">
.vault-metadata-tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid;
  border-radius: 10px;
  cursor: pointer;
  font-family: inherit;
  font-weight: 500;
  line-height: 1.2;
  text-align: left;
  transition: background-color 120ms ease, border-color 120ms ease;

  &--small {
    gap: 4px;
    padding: 2px 8px;
    border-radius: 8px;
    font-size: 14px;

    .vault-metadata-tag__icon {
      width: 14px;
      height: 14px;
    }

    .vault-metadata-tag__info {
      display: none;
      width: 11px;
      height: 11px;
    }
  }

  &--large {
    gap: 10px;
    padding: 12px 15px;
    font-size: 14.5px;

    .vault-metadata-tag__icon {
      width: 16px;
      height: 16px;
    }

    .vault-metadata-tag__info {
      width: 12.5px;
      height: 12.5px;
    }
  }

  &--block {
    width: 100%;
  }

  &--neutral {
    background-color: transparent;
    border-color: var(--border-subtle);
    color: var(--content-primary);

    &:hover {
      background-color: var(--bg-card-hover);
      border-color: var(--border-emphasis);
    }

    [data-theme="dark"] & {
      border-color: rgba(255, 255, 255, 0.1);

      &:hover {
        background-color: rgba(255, 255, 255, 0.04);
        border-color: rgba(255, 255, 255, 0.18);
      }
    }
  }

  &--accent {
    background-color: rgba(34, 211, 160, 0.08);
    border-color: rgba(34, 211, 160, 0.28);
    color: #22d3a0;

    &:hover {
      background-color: rgba(34, 211, 160, 0.12);
      border-color: rgba(34, 211, 160, 0.38);
    }
  }

  &--governance {
    background-color: rgba(136, 166, 204, 0.1);
    border-color: rgba(136, 166, 204, 0.3);
    color: #88a6cc;

    &:hover {
      background-color: rgba(136, 166, 204, 0.14);
      border-color: rgba(136, 166, 204, 0.4);
    }
  }

  &--warn {
    background-color: rgba(242, 177, 68, 0.13);
    border-color: rgba(242, 177, 68, 0.32);
    color: #f2b144;

    &:hover {
      background-color: rgba(242, 177, 68, 0.17);
      border-color: rgba(242, 177, 68, 0.42);
    }
  }

  &--danger {
    background-color: rgba(var(--error-rgb), 0.14);
    border-color: rgba(var(--error-rgb), 0.42);
    color: var(--error-500);

    &:hover {
      background-color: rgba(var(--error-rgb), 0.18);
      border-color: rgba(var(--error-rgb), 0.52);
    }
  }
}

.vault-metadata-tag__icon,
.vault-metadata-tag__info {
  flex-shrink: 0;
}

.vault-metadata-tag__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vault-metadata-tag__spacer {
  display: none;
}

.vault-metadata-tag--block {
  .vault-metadata-tag__spacer {
    display: block;
    flex: 1 1 auto;
  }

  .vault-metadata-tag__info {
    display: block;
  }
}

.vault-metadata-tag--small.vault-metadata-tag--nudge:not(.vault-metadata-tag--block) {
  gap: 8px;
  padding: 4px 10px;
  border-radius: 10px;
  font-size: 16px;
  transform: translateY(-4px);

  .vault-metadata-tag__icon {
    width: 24px;
    height: 24px;
  }
}

.vault-metadata-tag__info {
  opacity: 0.55;
}
</style>

<script setup lang="ts">
import { useToast } from '~/components/ui/composables/useToast'

type QueryValue = string | number | null | undefined
type Query = Record<string, QueryValue | QueryValue[]>

const props = withDefaults(defineProps<{
  path: string
  query?: Query
  label?: string
  tag?: 'button' | 'span'
  stopPropagation?: boolean
  variant?: 'default' | 'ghost'
}>(), {
  label: 'Copy link',
  tag: 'button',
  stopPropagation: false,
  variant: 'default',
})

const toast = useToast()
const router = useRouter()

const resolvedUrl = computed(() => {
  const href = router.resolve({
    path: props.path,
    query: props.query,
  }).href

  if (import.meta.client) {
    return new URL(href, window.location.origin).toString()
  }

  return href
})

const fallbackCopy = (text: string) => {
  const input = document.createElement('input')
  input.value = text
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.left = '-9999px'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()

  try {
    return document.execCommand('copy')
  }
  finally {
    document.body.removeChild(input)
  }
}

const writeToClipboard = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  if (!fallbackCopy(text)) {
    throw new Error('Clipboard copy failed')
  }
}

const { copied, copyToClipboard } = useClipboardCopy({ write: writeToClipboard })
const displayLabel = computed(() => copied.value ? 'Link copied' : props.label)

const copyLink = async (event?: Event) => {
  if (props.stopPropagation) {
    event?.preventDefault()
    event?.stopPropagation()
  }

  try {
    await copyToClipboard(resolvedUrl.value)
    toast.success('Link copied')
  }
  catch {
    toast.error('Could not copy link')
  }
}
</script>

<template>
  <component
    :is="tag"
    class="ui-share-link-button"
    :class="{ 'ui-share-link-button--ghost': variant === 'ghost' }"
    :type="tag === 'button' ? 'button' : undefined"
    :role="tag === 'span' ? 'button' : undefined"
    :tabindex="tag === 'span' ? 0 : undefined"
    :aria-label="displayLabel"
    @click="copyLink"
    @keydown.enter.prevent.stop="copyLink"
    @keydown.space.prevent.stop="copyLink"
  >
    <SvgIcon
      :name="copied ? 'check' : 'copy'"
      class="!w-18 !h-18"
    />
    <span
      role="tooltip"
      class="ui-share-link-button__tooltip"
    >
      {{ displayLabel }}
    </span>
  </component>
</template>

<style lang="scss">
.ui-share-link-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-surface-secondary);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s, color 0.15s;

  &:hover {
    border-color: var(--border-emphasis);
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  &:active {
    color: var(--text-secondary);
  }

  &--ghost {
    border-color: transparent;
    background: transparent;
    color: var(--text-muted);

    &:hover {
      border-color: transparent;
      background: var(--bg-surface-secondary);
      color: var(--text-secondary);
    }
  }

  &:focus-visible {
    outline: 2px solid var(--accent-600);
    outline-offset: 2px;
  }

  &:hover,
  &:focus-visible {
    .ui-share-link-button__tooltip {
      opacity: 1;
      transform: translate(-50%, -4px);
    }
  }

  &__tooltip {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    z-index: 20;
    width: max-content;
    max-width: 180px;
    padding: 6px 10px;
    border-radius: 8px;
    background: var(--ui-footnote-floating-background-color);
    box-shadow: 0 4px 16px var(--ui-footnote-floating-box-shadow-color);
    color: var(--text-primary);
    font-size: 13px;
    line-height: 18px;
    font-weight: 400;
    pointer-events: none;
    opacity: 0;
    transform: translate(-50%, 0);
    transition: opacity 0.15s, transform 0.15s;
    white-space: nowrap;
  }
}
</style>

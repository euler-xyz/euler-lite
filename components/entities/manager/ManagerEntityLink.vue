<script setup lang="ts">
import type { EulerLabelEntity } from '~/entities/euler/labels'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { getEulerLabelEntityDisplayName, getEulerLabelEntitySlug, getManagerProfilePath } from '~/utils/manager-profile'

const props = withDefaults(defineProps<{
  entities: EulerLabelEntity[]
  label?: string
  showAvatar?: boolean
  spanLink?: boolean
  textClass?: string
  avatarClass?: string
  dataKey?: string
  dataField?: string
  disabled?: boolean
}>(), {
  label: '',
  showAvatar: true,
  spanLink: false,
  textClass: 'text-p2 text-content-primary hover:text-accent-600 underline transition-colors',
  avatarClass: 'icon--20',
  dataKey: '',
  dataField: '',
  disabled: false,
})

const { entities: entityMap } = useEulerLabels()
const route = useRoute()

const displayName = computed(() => props.label || getEulerLabelEntityDisplayName(props.entities))
const entityLogos = computed(() => props.entities.map(entity => getEulerLabelEntityLogo(entity.logo)))
const primarySlug = computed(() => {
  const first = props.entities[0]
  return first ? getEulerLabelEntitySlug(entityMap, first) : ''
})
const to = computed(() => ({
  path: getManagerProfilePath(primarySlug.value),
  query: { network: route.query.network },
}))
const isLinked = computed(() => Boolean(primarySlug.value) && props.entities.length === 1 && !props.disabled)
const fallbackTextClass = computed(() =>
  props.textClass.replace('hover:text-accent-600 underline transition-colors', ''),
)

const goToManager = () => {
  if (!isLinked.value) return
  void navigateTo(to.value)
}

const onSpanKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  event.stopPropagation()
  goToManager()
}
</script>

<template>
  <span class="inline-flex min-w-0 items-center gap-6">
    <BaseAvatar
      v-if="showAvatar"
      :class="avatarClass"
      :label="displayName"
      :src="entityLogos"
    />
    <span
      v-if="spanLink && isLinked"
      role="link"
      tabindex="0"
      :class="textClass"
      :data-id="dataKey && dataField ? 'data-point' : undefined"
      :data-key="dataKey || undefined"
      :data-field="dataField || undefined"
      :data-value="displayName"
      @click.stop.prevent="goToManager"
      @keydown="onSpanKeydown"
    >{{ displayName }}</span>
    <NuxtLink
      v-else-if="isLinked"
      :to="to"
      :class="textClass"
      :data-id="dataKey && dataField ? 'data-point' : undefined"
      :data-key="dataKey || undefined"
      :data-field="dataField || undefined"
      :data-value="displayName"
    >{{ displayName }}</NuxtLink>
    <span
      v-else
      :class="fallbackTextClass"
      :data-id="dataKey && dataField ? 'data-point' : undefined"
      :data-key="dataKey || undefined"
      :data-field="dataField || undefined"
      :data-value="displayName"
    >{{ displayName }}</span>
  </span>
</template>

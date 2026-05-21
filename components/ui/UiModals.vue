<script setup lang="ts">
import { useModal } from './composables/useModal'

const { list } = useModal()
</script>

<template>
  <div
    v-if="list.length"
    class="ui-modals"
  >
    <transition-group name="modal-layer">
      <UiModal
        v-for="modal in list"
        v-show="modal"
        :id="modal.id"
        :key="modal.id"
        :component="modal.component"
        :data="modal.data"
      />
    </transition-group>
  </div>
</template>

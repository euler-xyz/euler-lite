<template>
  <UiHoverPreviewTooltip
    title="Recently added"
    text="This vault was added recently."
    placement="top-start"
  >
    <span
      class="recently-added-badge relative inline-flex items-center gap-4 rounded-8 px-8 py-2 text-p5 mobile:gap-0 mobile:rounded-full mobile:w-26 mobile:h-26 mobile:p-0 mobile:justify-center"
    >
      <SvgIcon
        name="star"
        class="!w-14 !h-14"
      />
      <span class="mobile:hidden">Recently added</span>
    </span>
  </UiHoverPreviewTooltip>
</template>

<style scoped lang="scss">
.recently-added-badge {
  border: 1px solid rgba(34, 211, 160, 0.28);
  color: #22d3a0;
  background-color: rgba(34, 211, 160, 0.08);
  transition: background-color 120ms ease, border-color 120ms ease;
}
</style>

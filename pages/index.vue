<script setup lang="ts">
// On the zipcode-demo branch the root lands on the Zip Code Finance demo.
// The Euler app remains reachable at its own routes (/earn, /portfolio, …).
// Non-blocking to avoid Suspense + pageTransition crash on direct navigation.
navigateTo('/zipcode', { replace: true })
</script>

<template>
  <div />
</template>

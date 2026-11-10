<script setup lang="ts">
defineProps<{ value: number }>()
</script>

<template>
  <input :value="value" />
</template>

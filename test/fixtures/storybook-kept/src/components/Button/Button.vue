<script setup lang="ts">
defineProps<{ label: string; icon?: string }>()
</script>

<template>
  <button class="button">{{ label }}</button>
</template>

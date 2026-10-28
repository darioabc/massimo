<template>
  <span class="badge badge-info">{{ label }}</span>
</template>

<script setup lang="ts">
import Icon from './Icon'

defineProps<{ label: string }>()
</script>

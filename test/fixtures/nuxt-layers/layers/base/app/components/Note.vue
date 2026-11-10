<script setup lang="ts">
import { label } from '~/utils/label'

defineProps<{ items: string[], when: string }>()
</script>

<template>
  <BaseCard>{{ label }} {{ when }}</BaseCard>
</template>

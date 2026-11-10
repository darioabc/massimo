<script setup lang="ts">
import { cn } from '@/lib/utils'

defineProps<{ variant?: 'default' | 'ghost' }>()
</script>

<template>
  <button :class="cn('button', variant)"><slot /></button>
</template>

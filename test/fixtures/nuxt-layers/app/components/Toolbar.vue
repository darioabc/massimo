<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { useState } from '#imports'
import missing from '@/missing/thing'

const open = useState('open', () => missing)
</script>

<template>
  <nav>
    <Button @click="open = !open">Toggle</Button>
    <!-- <Unused /> in a comment is not a use -->
  </nav>
</template>

<script setup lang="ts">
import { formatDate } from '#shared/format'
import items from '#data/items'
import Note from '#layers/base/app/components/Note.vue'

const Card = resolveComponent('BaseCard')
</script>

<template>
  <main>
    <component :is="Card" />
    <Toolbar />
    <Note :items="items" :when="formatDate(new Date())" />
  </main>
</template>

<script setup lang="ts">
import FormInput from '~/components/form/FormInput.vue'
</script>

<template>
  <header>
    <component :is="FormInput" :value="1" />
  </header>
</template>

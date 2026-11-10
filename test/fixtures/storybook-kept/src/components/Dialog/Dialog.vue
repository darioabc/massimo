<script setup lang="ts">
import Button from '../Button/Button.vue'
</script>

<template>
  <dialog open><slot /><Button label="Close" /></dialog>
</template>
